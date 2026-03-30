import axios from 'axios';

export default async function handler(req, res) {
  // 1. Limpieza de credenciales
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  
  // 2. EL REMITENTE (LA CLAVE DEL ERROR 21212)
  // IMPORTANTE: Aquí debe ir el número de SANDBOX de Twilio, no el tuyo.
  let fromRaw = (process.env.TWILIO_PHONE || '').trim();
  
  // Limpiamos el número para que sea puro E.164 (+123456789)
  const fromClean = fromRaw.replace('whatsapp:', '').replace(/\s+/g, '');
  const fromFinal = `whatsapp:${fromClean}`; // Resultado: whatsapp:+14155238886

  // 3. EL DESTINATARIO
  const toFinal = 'whatsapp:+593995430859';

  try {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // Consulta a Airtable
    const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`)}`;
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    let total = 0;
    citas.forEach(r => total += parseFloat(r.fields["Importe estimado"] || 0));

    // Mensaje de Anesi
    const mensaje = `📊 *AuraSync: Balance Diario*\n\n✅ Citas hoy: ${citas.length}\n💰 Total: $${total.toFixed(2)}\n\n_Mensaje de AuraSync : El Asistente Premium._`;

    // 4. Envío por Twilio (Cuerpo del mensaje codificado)
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

    return res.status(200).json({ success: true, fromUsed: fromFinal });

  } catch (error) {
    // Si falla, mostramos el error real de Twilio para debuggear
    console.error('DEBUG TWILIO:', error.response?.data);
    return res.status(500).json({ 
      error: "Error 21212 detectado", 
      detalle: error.response?.data || error.message 
    });
  }
}
