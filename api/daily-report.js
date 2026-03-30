import axios from 'axios';

export default async function handler(req, res) {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  
  // Número de Twilio Sandbox (ej: +14155238886) o tu número WhatsApp aprobado
  const twilioNumber = process.env.TWILIO_PHONE?.trim().replace('whatsapp:', '');
  const fromFinal = `whatsapp:${twilioNumber}`;
  
  // Número del dueño (debe tener WhatsApp y unirse al sandbox primero)
  const toFinal = 'whatsapp:+593995430859';

  try {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`)}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    let total = 0;
    citas.forEach(r => total += parseFloat(r.fields["Importe estimado"] || 0));

    const mensaje = `📊 *AuraSync: Balance Diario*\n\n✅ Citas hoy: ${citas.length}\n💰 Total: $${total.toFixed(2)}\n\n_Mensaje de AuraSync : El Asistente Premium._`;

    const params = new URLSearchParams();
    params.append('To', toFinal);
    params.append('From', fromFinal);
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

    return res.status(200).json({ success: true, fromUsed: fromFinal, to: toFinal });

  } catch (error) {
    console.error('DEBUG TWILIO:', error.response?.data);
    return res.status(500).json({ 
      error: "Error en envío", 
      detalle: error.response?.data || error.message 
    });
  }
}
