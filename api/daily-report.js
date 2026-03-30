import axios from 'axios';

export default async function handler(req, res) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  
  // Forzamos el formato E.164 que pide Twilio en el log
  let fromNumber = process.env.TWILIO_PHONE.trim();
  if (!fromNumber.startsWith('whatsapp:')) {
      fromNumber = `whatsapp:${fromNumber.startsWith('+') ? fromNumber : '+' + fromNumber}`;
  }

  try {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // 1. Traer datos de Airtable
    const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`)}`;
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    let ingresos = 0;
    citas.forEach(r => ingresos += parseFloat(r.fields["Importe estimado"] || 0));

    // 2. Formatear mensaje con la identidad de Anesi
    const mensajeBody = `📊 *AuraSync: Balance Diario*\n\n✅ Citas hoy: ${citas.length}\n💰 Total: $${ingresos.toFixed(2)}\n\n_Mensaje de AuraSync: El Asistente Premium._`;

    // 3. Envío a Twilio usando URLSearchParams (Formato oficial)
    const params = new URLSearchParams();
    params.append('To', 'whatsapp:+593995430859'); // Tu número
    params.append('From', fromNumber);
    params.append('Body', mensajeBody);

    const auth = Buffer.from(`${sid}:${token}`).toString('base64');

    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      params.toString(),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return res.status(200).json({ success: true, info: "Reporte enviado con éxito" });

  } catch (error) {
    return res.status(500).json({ error: error.response?.data || error.message });
  }
}
