import axios from 'axios';

export default async function handler(req, res) {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Faltan credenciales de Twilio');
    }

    const sid = process.env.TWILIO_ACCOUNT_SID.trim();
    const token = process.env.TWILIO_AUTH_TOKEN.trim();
    const twilioNumber = process.env.TWILIO_NUMBER?.trim().replace('whatsapp:', '') || '14155238886';
    const fromFinal = `whatsapp:${twilioNumber}`;

    // 1. Obtener fecha de MAÑANA en la zona horaria local (Ecuador)
    const ahora = new Date();
    const mañana = new Date(ahora);
    mañana.setDate(mañana.getDate() + 1);
    
    const opciones = { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' };
    const formatter = new Intl.DateTimeFormat('en-CA', opciones);
    const fechaMañana = formatter.format(mañana); 

    // 2. Consultar Airtable para las citas confirmadas de mañana
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableName = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Citas');
    const formula = encodeURIComponent(`AND({Fecha} = '${fechaMañana}', {Estado} = 'Confirmada')`);
    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula=${formula}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    console.log(`🔔 Procesando ${citas.length} recordatorios para el ${fechaMañana}...`);

    // 3. Enviar recordatorios con un tono sofisticado y profesional
    for (const cita of citas) {
      const f = cita.fields;
      const telefono = f["Teléfono"];
      const nombre = f["Cliente"]?.split(' ')[0] || "Cliente";
      const hora = f["Hora"];
      const servicio = f["Servicio"];

      if (!telefono) continue;

      const mensajePremium = `✨ *RECORDATORIO EXCLUSIVO - AuraSync* ✨\n\n` +
        `Hola *${nombre}*, es un placer saludarte.\n\n` +
        `Te recordamos que mañana tienes una cita con nosotros:\n\n` +
        `📅 *Fecha*: ${fechaMañana}\n` +
        `⏰ *Hora*: ${hora}\n` +
        `💆‍♀️ *Servicio*: ${servicio}\n\n` +
        `Estamos preparando todo para brindarte la mejor experiencia. ¡Te esperamos!\n\n` +
        `_Si necesitas reprogramar o cancelar, solo dímelo por aquí y yo me encargo._`;

      try {
        await enviarWhatsApp(fromFinal, `whatsapp:${telefono}`, mensajePremium, sid, token);
        console.log(`✅ Recordatorio enviado a ${telefono}`);
      } catch (err) {
        console.error(`❌ Error enviando recordatorio a ${telefono}:`, err.message);
      }
    }

    return res.status(200).json({ success: true, count: citas.length });

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
