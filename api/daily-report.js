import axios from 'axios';

export default async function handler(req, res) {
  // Sacamos las variables y les quitamos espacios por si acaso
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const fromNum = (process.env.TWILIO_PHONE || '').trim();
  const toNum = 'whatsapp:+593995430859'; // Tu número directo para pruebas

  try {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // 1. Consultar Airtable
    const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Citas')}?filterByFormula=${encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`)}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    let total = 0;
    citas.forEach(r => total += parseFloat(r.fields["Importe estimado"] || 0));

    // 2. Preparar Mensaje
    const mensaje = `📊 *Balance Diario AuraSync*\nCitas: ${citas.length}\nTotal: $${total.toFixed(2)}\n_Generado por Aura._`;

    // 3. Envío Manual a Twilio (Formato exacto x-www-form-urlencoded)
    const params = new URLSearchParams();
    params.append('To', toNum);
    params.append('From', fromNum);
    params.append('Body', mensaje);

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

    return res.status(200).json({ success: true, enviadoA: toNum });

  } catch (error) {
    console.error('Error Twilio:', error.response?.data || error.message);
    return res.status(500).json({ 
      error: "Fallo en Twilio", 
      detalle: error.response?.data || error.message 
    });
  }
}
