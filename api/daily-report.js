import axios from 'axios';

export default async function handler(req, res) {
  // 1. Carga y limpieza profunda de variables
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const airtableToken = (process.env.AIRTABLE_TOKEN || '').trim();
  const baseId = (process.env.AIRTABLE_BASE_ID || '').trim();
  
  // Forzamos el prefijo 'whatsapp:' para evitar el error de canal
  let fromNum = (process.env.TWILIO_PHONE || '').trim();
  if (fromNum && !fromNum.startsWith('whatsapp:')) {
    fromNum = `whatsapp:${fromNum.startsWith('+') ? fromNum : '+' + fromNum}`;
  }

  // Configuración de destinatarios (puedes añadir más separados por coma)
  const destinatarios = ['whatsapp:+593995430859'];

  try {
    // 2. Obtener fecha actual en Ecuador
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

    // 3. Consulta a Airtable
    const tabla = process.env.AIRTABLE_TABLE_NAME || 'Citas';
    const formula = encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`);
    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tabla)}?filterByFormula=${formula}`;

    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${airtableToken}` }
    });

    const citas = airtableRes.data.records || [];
    
    // Si no hay citas, terminamos para no enviar un reporte vacío
    if (citas.length === 0) {
      return res.status(200).json({ success: true, message: `Sin citas para el ${hoy}.` });
    }

    // 4. Cálculo de métricas
    let ingresos = 0;
    const servicios = {};
    citas.forEach(cita => {
      ingresos += parseFloat(cita.fields["Importe estimado"] || 0);
      const s = cita.fields["Servicio"] || "General";
      servicios[s] = (servicios[s] || 0) + 1;
    });
    const topServicio = Object.keys(servicios).reduce((a, b) => servicios[a] > servicios[b] ? a : b);

    // 5. Construcción del mensaje
    const fechaLarga = ahora.toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' });
    const cuerpoMensaje = 
      `📊 *Reporte AuraSync - ${fechaLarga}*\n` +
      `----------------------------------\n` +
      `✅ Citas atendidas: ${citas.length}\n` +
      `💰 Ingresos totales: $${ingresos.toFixed(2)}\n` +
      `💇‍♂️ Servicio estrella: ${topServicio}\n` +
      `----------------------------------\n` +
      `_Enviado por Anesi: Guardián de la Coherence._`;

    // 6. Envío masivo a Twilio
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const promesas = destinatarios.map(toNum => {
      const params = new URLSearchParams();
      params.append('To', toNum.trim());
      params.append('From', fromNum);
      params.append('Body', cuerpoMensaje);

      return axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        params.toString(),
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
    });

    await Promise.all(promesas);
    return res.status(200).json({ success: true, citas: citas.length });

  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('Error en el reporte:', errorData);
    return res.status(500).json({ error: "Fallo en el proceso", detalle: errorData });
  }
}
