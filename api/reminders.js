import axios from 'axios';

// Función para obtener la fecha de Ecuador con un desplazamiento de días
function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  // Formateamos la fecha actual en la zona horaria de Ecuador
  const opciones = { timeZone: 'America/Guayaquil', year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  
  // Creamos una fecha base en UTC al mediodía para evitar problemas de zona horaria
  const fecha = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  
  return fecha.toISOString().split('T')[0]; // Retorna YYYY-MM-DD
}

// Función para poner la fecha bonita (ej: viernes, 10 de abril)
function formatearFechaElegante(fechaISO) {
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'UTC'
  });
}

export default async function handler(req, res) {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Faltan credenciales de Twilio');
    }

    const sid = process.env.TWILIO_ACCOUNT_SID.trim();
    const token = process.env.TWILIO_AUTH_TOKEN.trim();
    const twilioNumber = process.env.TWILIO_NUMBER?.trim().replace('whatsapp:', '') || '14155238886';
    const fromFinal = `whatsapp:${twilioNumber}`;

    // 1. Obtener fecha de MAÑANA de forma segura
    const fechaMañanaISO = getFechaEcuador(1);
    const fechaBonita = formatearFechaElegante(fechaMañanaISO);

    // 2. Consultar Airtable para las citas confirmadas de mañana
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableName = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Citas');
    // Filtramos por la fecha ISO (YYYY-MM-DD) que es como Airtable maneja los campos de fecha
    const formula = encodeURIComponent(`AND({Fecha} = '${fechaMañanaISO}', {Estado} = 'Confirmada')`);
    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula=${formula}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    console.log(`🔔 Procesando ${citas.length} recordatorios para el ${fechaMañanaISO}...`);

    // 3. Enviar recordatorios con el estilo Aura
    for (const cita of citas) {
      const f = cita.fields;
      const telefono = f["Teléfono"];
      const nombre = f["Cliente"]?.split(' ')[0] || "estimado cliente";
      const hora = f["Hora"] || "hora por confirmar";
      const servicio = f["Servicio"] || "tu servicio";
      const especialista = f["Especialista"] || "nuestro equipo";

      if (!telefono) continue;

      const mensajePremium = `✨ *RECORDATORIO EXCLUSIVO - AuraSync* ✨\n\n` +
        `Hola *${nombre}*, es un placer saludarte.\n\n` +
        `Paso por aquí para recordarte que mañana tenemos una cita preparada para ti:\n\n` +
        `📅 *Fecha*: ${fechaBonita}\n` +
        `⏰ *Hora*: ${hora}\n` +
        `💆‍♀️ *Servicio*: ${servicio}\n` +
        `👤 *Especialista*: ${especialista}\n\n` +
        `Estamos cuidando cada detalle para que tu experiencia sea excepcional. ¡Te esperamos!\n\n` +
        `_Si necesitas realizar algún cambio de último momento, solo dímelo por aquí y yo me encargaré de todo._`;

      try {
        await enviarWhatsApp(fromFinal, `whatsapp:${telefono}`, mensajePremium, sid, token);
        console.log(`✅ Recordatorio enviado a ${telefono}`);
      } catch (err) {
        console.error(`❌ Error enviando recordatorio a ${telefono}:`, err.response?.data || err.message);
      }
    }

    return res.status(200).json({ success: true, count: citas.length, fechaProcesada: fechaMañanaISO });

  } catch (error) {
    console.error('❌ Error en recordatorios:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

async function enviarWhatsApp(from, to, body, sid, token) {
  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', from);
  params.append('Body', body);
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  return axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    params.toString(),
    { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
}
