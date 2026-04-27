import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER: process.env.TWILIO_NUMBER || '14155238886'
};

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: 'America/Guayaquil', year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year')?.value || '2026';
  const month = parts.find(p => p.type === 'month')?.value || '1';
  const day = parts.find(p => p.type === 'day')?.value || '1';
  const fecha = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO || 'fecha por confirmar';
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatearHora(horaStr) {
  if (!horaStr) return '';
  const [h, m] = horaStr.split(':').map(Number);
  const periodo = h >= 12 ? 'p.m.' : 'a.m.';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

async function enviarWhatsApp(to, body) {
  const sid = CONFIG.TWILIO_ACCOUNT_SID;
  const token = CONFIG.TWILIO_AUTH_TOKEN;
  const from = `whatsapp:${CONFIG.TWILIO_NUMBER}`;
  const toFinal = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const params = new URLSearchParams();
  params.append('To', toFinal);
  params.append('From', from);
  params.append('Body', body);

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      params.toString(),
      { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return { ok: true };
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

// Verificar disponibilidad real
async function verificarDisponibilidadReal(fecha, hora, duracion, especialistaNombre) {
  const inicioDia = `${fecha}T00:00:00`;
  const finDia = `${fecha}T23:59:59`;

  const { data: citas } = await supabase
    .from('citas')
    .select('fecha_hora, duracion_aux, especialista_id, especialistas(nombre)')
    .eq('estado', 'Confirmada')
    .gte('fecha_hora', inicioDia)
    .lte('fecha_hora', finDia);

  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracion || 60);

  for (const cita of citas || []) {
    const horaCita = cita.fecha_hora.substring(11, 16);
    const [hc, mc] = horaCita.split(':').map(Number);
    const inicioExistente = hc * 60 + mc;
    const finExistente = inicioExistente + (cita.duracion_aux || 60);

    if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
      if (!especialistaNombre || cita.especialistas?.nombre === especialistaNombre) {
        return { ok: false };
      }
    }
  }
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // 1. Buscar eventos de cancelación/reagendamiento no procesados
    const { data: eventos, error: errorEventos } = await supabase
      .from('eventos_cambio_cita')
      .select('*')
      .eq('procesado', false)
      .order('creado_en', { ascending: true })
      .limit(50);

    if (errorEventos) {
      console.error('❌ Error leyendo eventos:', errorEventos);
      return res.status(500).json({ error: errorEventos.message });
    }

    console.log(`📋 Procesando ${eventos?.length || 0} eventos de cancelación/reagendamiento...`);

    let procesados = 0;
    let notificados = 0;
    let expirados = 0;

    for (const evento of eventos || []) {
      const fecha = evento.fecha_hora_liberada.split('T')[0];
      const hora = evento.fecha_hora_liberada.substring(11, 16);

      // Verificar que el hueco siga libre
      const disponible = await verificarDisponibilidadReal(fecha, hora, evento.duracion || 60, null);

      if (!disponible.ok) {
        console.log(`⚠️ Hueco ${fecha} ${hora} ya no está libre, marcando evento como procesado`);
        await supabase.from('eventos_cambio_cita').update({ procesado: true }).eq('id', evento.id);
        procesados++;
        continue;
      }

      // Buscar candidatos en lista de espera
      const { data: candidatos, error: errorCandidatos } = await supabase
        .from('lista_espera')
        .select('*')
        .eq('estado', 'Pendiente')
        .eq('fecha_solicitada', fecha)
        .lte('hora_solicitada', hora)
        .gte('expira_en', new Date().toISOString())
        .order('orden', { ascending: true })
        .order('creado_en', { ascending: true })
        .limit(3); // Intentar con los primeros 3

      if (errorCandidatos) {
        console.error('❌ Error buscando candidatos:', errorCandidatos);
        continue;
      }

      if (!candidatos?.length) {
        console.log(`ℹ️ No hay candidatos para ${fecha} ${hora}`);
        await supabase.from('eventos_cambio_cita').update({ procesado: true }).eq('id', evento.id);
        procesados++;
        continue;
      }

      // Notificar al primer candidato válido
      let notificado = false;
      for (const candidato of candidatos) {
        // Verificar que el hueco siga libre para este candidato específico
        const dispCandidato = await verificarDisponibilidadReal(
          fecha, hora, evento.duracion || 60, candidato.especialista_preferido_nombre
        );

        if (!dispCandidato.ok) continue;

        const mensaje = `✨ *¡Buenas noticias${candidato.nombre_cliente ? ', ' + candidato.nombre_cliente.split(' ')[0] : ''}!* ✨

` +
          `Se liberó un cupo para *${candidato.servicio_nombre}* el *${formatearFecha(fecha)}* a las *${formatearHora(hora)}*.

` +
          `¿Lo quieres? Responde *SÍ* en los próximos 15 minutos y te lo agendo. 🌸

` +
          `_Si no respondes, pasaremos al siguiente de la lista._`;

        const envio = await enviarWhatsApp(candidato.telefono, mensaje);

        if (envio.ok) {
          await supabase.from('lista_espera')
            .update({
              estado: 'Notificado',
              notificado_en: new Date().toISOString(),
              intentos_notificacion: candidato.intentos_notificacion + 1
            })
            .eq('id', candidato.id);

          // Guardar en conversaciones para que el webhook sepa que es una notificación de lista de espera
          await supabase.from('conversaciones').insert([
            {
              telefono: candidato.telefono,
              rol: 'system',
              contenido: `NOTIFICACION_LISTA_ESPERA:${JSON.stringify({
                lista_espera_id: candidato.id,
                fecha, hora,
                servicio: candidato.servicio_nombre,
                servicio_id: candidato.servicio_id,
                especialista: candidato.especialista_preferido_nombre || 'Asignar',
                especialista_id: candidato.especialista_preferido_id,
                precio: 0, // Se puede buscar en servicios
                duracion: evento.duracion || 60
              })}`
            }
          ]);

          console.log(`✅ Notificación enviada a ${candidato.telefono} para ${fecha} ${hora}`);
          notificado = true;
          notificados++;
          break; // Solo notificar al primero válido
        }
      }

      // Marcar evento como procesado
      await supabase.from('eventos_cambio_cita').update({ procesado: true }).eq('id', evento.id);
      procesados++;
    }

    // 2. Limpiar entradas expiradas de lista de espera
    const { data: expiradosData } = await supabase
      .from('lista_espera')
      .update({ estado: 'Expirado' })
      .eq('estado', 'Pendiente')
      .lt('expira_en', new Date().toISOString())
      .select();

    expirados = expiradosData?.length || 0;
    if (expirados > 0) {
      console.log(`🧹 ${expirados} entradas de lista de espera expiradas limpiadas`);
    }

    return res.status(200).json({
      success: true,
      eventosProcesados: procesados,
      notificacionesEnviadas: notificados,
      expiradosLimpios: expirados
    });

  } catch (error) {
    console.error('❌ Error en processor lista de espera:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
