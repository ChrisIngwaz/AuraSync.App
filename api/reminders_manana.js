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

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const hoy = getFechaEcuador(0);
    const ahora = new Date();
    const horaActual = ahora.getHours();
    const minActual = ahora.getMinutes();
    const minutosActuales = horaActual * 60 + minActual;

    // Buscar citas confirmadas de HOY que:
    // 1. NO hayan recibido recordatorio 2h
    // 2. Sean dentro de las próximas 2-4 horas
    // 3. El cliente haya confirmado el recordatorio 24h (o no importa, enviamos igual)

    const inicioDia = `${hoy}T00:00:00`;
    const finDia = `${hoy}T23:59:59`;

    const { data: citas, error } = await supabase
      .from('citas')
      .select(`
        id, fecha_hora, servicio_aux, duracion_aux, especialista_id,
        nombre_cliente_aux, cliente_id, confirmacion_cliente,
        clientes:cliente_id (telefono, nombre, apellido),
        especialistas:especialista_id (nombre)
      `)
      .eq('estado', 'Confirmada')
      .eq('recordatorio_2h_enviado', false)
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);

    if (error) {
      console.error('❌ Error consultando citas:', error);
      return res.status(500).json({ error: error.message });
    }

    let enviados = 0;
    let fallidos = 0;
    let saltados = 0;

    for (const cita of citas || []) {
      const horaCita = cita.fecha_hora.substring(11, 16);
      const [hc, mc] = horaCita.split(':').map(Number);
      const minutosCita = hc * 60 + mc;
      const diferenciaMinutos = minutosCita - minutosActuales;

      // Solo enviar si la cita es entre 2h y 4h desde ahora
      // (evitar enviar a las 7am para cita de las 3pm)
      if (diferenciaMinutos < 120 || diferenciaMinutos > 240) {
        saltados++;
        continue;
      }

      const telefono = cita.clientes?.telefono;
      const nombre = cita.clientes?.nombre || cita.nombre_cliente_aux?.split(' ')[0] || 'estimado cliente';
      const fecha = cita.fecha_hora.split('T')[0];
      const servicio = cita.servicio_aux || 'tu servicio';
      const especialista = cita.especialistas?.nombre || 'nuestro equipo';

      if (!telefono) {
        console.log(`⚠️ Cita ${cita.id} sin teléfono, saltando...`);
        continue;
      }

      // Mensaje diferente según si confirmó o no el recordatorio 24h
      const confirmo24h = cita.confirmacion_cliente === 'Confirmada';

      let mensaje;
      if (confirmo24h) {
        mensaje = `✨ *¡Nos vemos pronto, ${nombre}!* ✨

` +
          `Tu cita de *${servicio}* es *hoy* a las *${formatearHora(horaCita)}* con *${especialista}*.

` +
          `Te esperamos con mucho cariño. 🌸

` +
          `_Dirección: [Tu dirección aquí]_`;
      } else {
        mensaje = `✨ *RECORDATORIO - AuraSync* ✨

` +
          `Hola *${nombre}*,

` +
          `Tu cita de *${servicio}* es *hoy* a las *${formatearHora(horaCita)}* con *${especialista}*.

` +
          `¿Sigues confirmado? Responde *SÍ* o avísame si necesitas cambiar algo. 🌸`;
      }

      const envio = await enviarWhatsApp(telefono, mensaje);

      if (envio.ok) {
        await supabase
          .from('citas')
          .update({
            recordatorio_2h_enviado: true,
            recordatorio_2h_enviado_en: new Date().toISOString()
          })
          .eq('id', cita.id);

        if (!confirmo24h) {
          await supabase.from('conversaciones').insert([
            { telefono: telefono, rol: 'system', contenido: `RECORDATORIO_CITA_ID:${cita.id}` }
          ]);
        }

        enviados++;
        console.log(`✅ Recordatorio 2h enviado a ${telefono} (cita a las ${horaCita})`);
      } else {
        fallidos++;
        console.error(`❌ Falló envío a ${telefono}`);
      }
    }

    return res.status(200).json({
      success: true,
      fechaProcesada: hoy,
      enviados,
      fallidos,
      saltados,
      total: citas?.length || 0
    });

  } catch (error) {
    console.error('❌ Error en recordatorios mañana:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
