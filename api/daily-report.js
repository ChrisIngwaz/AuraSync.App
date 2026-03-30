import axios from 'axios';

export default async function handler(req, res) {
  // 1. Limpieza total de credenciales
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  
  // 2. Formateo forzado del remitente (El número del Sandbox)
  let rawFrom = (process.env.TWILIO_PHONE || '').trim();
  // Eliminamos cualquier texto extra y dejamos solo el número con +
  let cleanFrom = rawFrom.replace('whatsapp:', '').replace(/\s/g, '');
  const fromWhatsApp = `whatsapp:${cleanFrom}`;

  const toWhatsApp = 'whatsapp:+593995430859'; 

  try {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // 3. Consulta Airtable
    const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Citas')}?filterByFormula=${encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`)}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    let total = 0;
    citas.forEach(r => total += parseFloat(r.fields["Importe estimado"] || 0));

    // 4. Construcción del mensaje (Identidad Anesi)
    const mensajeBody = 
      `📊 *Reporte AuraSync - Hoy*\n` +
      `----------------------------------\n` +
      `✅ Citas: ${citas.length}\n` +
      `💰 Total: $${total.toFixed(2)}\n` +
      `----------------------------------\n` +
      `_Enviado por AuraSync : El Asistente Premium._`;

    // 5. Envío directo con URLSearchParams
    const params = new URLSearchParams();
    params.append('To', toWhatsApp);
    params.append('From', fromWhatsApp);
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

    return res.status(200).json({ success: true, de: fromWhatsApp });

  } catch (error) {
    const detalle = error.response?.data || error.message;
    console.error('Error final:', detalle);
    return res.status(500).json({ error: detalle });
  }
}
