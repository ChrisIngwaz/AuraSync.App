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
    // Seguridad: solo ejecutar con secret o cron verificado
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const fechaMañana = getFechaEcuador(1);
    const inicioDia = `${fechaMañana}T00:00:00`;
    const finDia = `${fechaMañana}T23:59:59`;

    // Buscar citas confirmadas de mañana que NO hayan recibido recordatorio 24h
    const { data: citas, error } = await supabase
      .from('citas')
      .select(`
        id, fecha_hora, servicio_aux, duracion_aux, especialista_id,
        nombre_cliente_aux, cliente_id,
        clientes:cliente_id (telefono, nombre, apellido),
        especialistas:especialista_id (nombre)
      `)
      .eq('estado', 'Confirmada')
      .eq('recordatorio_24h_enviado', false)
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);

    if (error) {
      console.error('❌ Error consultando citas:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`🔔 Procesando ${citas?.length || 0} recordatorios 24h para ${fechaMañana}...`);

    let enviados = 0;
    let fallidos = 0;

    for (const cita of citas || []) {
      const telefono = cita.clientes?.telefono;
      const nombre = cita.clientes?.nombre || cita.nombre_cliente_aux?.split(' ')[0] || 'estimado cliente';
      const fecha = cita.fecha_hora.split('T')[0];
      const hora = cita.fecha_hora.substring(11, 16);
      const servicio = cita.servicio_aux || 'tu servicio';
      const especialista = cita.especialistas?.nombre || 'nuestro equipo';

      if (!telefono) {
        console.log(`⚠️ Cita ${cita.id} sin teléfono, saltando...`);
        continue;
      }

      const mensaje = `✨ *RECORDATORIO - AuraSync* ✨

` +
        `Hola *${nombre}*,

` +
        `Te recordamos que mañana tienes una cita:

` +
        `📅 *Fecha*: ${formatearFecha(fecha)}
` +
        `⏰ *Hora*: ${formatearHora(hora)}
` +
        `💆‍♀️ *Servicio*: ${servicio}
` +
        `👤 *Especialista*: ${especialista}

` +
        `¿Todo en orden? Responde *SÍ* para confirmar, o dime si necesitas reagendar o cancelar. 🌸

` +
        `_Si necesitas hacer algún cambio, responde a este mensaje y yo me encargo._`;

      const envio = await enviarWhatsApp(telefono, mensaje);

      if (envio.ok) {
        // Marcar como enviado
        await supabase
          .from('citas')
          .update({
            recordatorio_24h_enviado: true,
            recordatorio_24h_enviado_en: new Date().toISOString(),
            confirmacion_cliente: 'Pendiente'
          })
          .eq('id', cita.id);

        // Guardar en conversaciones para que el webhook sepa que es una confirmación
        await supabase.from('conversaciones').insert([
          { telefono: telefono, rol: 'system', contenido: `RECORDATORIO_CITA_ID:${cita.id}` }
        ]);

        enviados++;
        console.log(`✅ Recordatorio 24h enviado a ${telefono}`);
      } else {
        fallidos++;
        console.error(`❌ Falló envío a ${telefono}`);
      }
    }

    return res.status(200).json({
      success: true,
      fechaProcesada: fechaMañana,
      enviados,
      fallidos,
      total: citas?.length || 0
    });

  } catch (error) {
    console.error('❌ Error en recordatorios noche:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
