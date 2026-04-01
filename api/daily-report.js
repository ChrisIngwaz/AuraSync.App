import axios from 'axios';

export default async function handler(req, res) {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  
  const twilioNumber = process.env.TWILIO_NUMBER?.trim().replace('whatsapp:', '');
  const fromFinal = `whatsapp:${twilioNumber}`;
  const toFinal = 'whatsapp:+593995430859';

  try {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    
    // Formato de fecha bonito: "Lunes 30 de marzo"
    const fechaFormateada = ahora.toLocaleDateString('es-EC', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      timeZone: 'America/Guayaquil'
    });

    // Consulta Airtable
    const airtableUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(`IS_SAME({Fecha}, '${hoy}', 'day')`)}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const citas = airtableRes.data.records || [];
    
    if (citas.length === 0) {
      const mensajeVacio = `📊 *AURA SYNC - Reporte Diario*\n\n📅 ${fechaFormateada}\n\n⚠️ *No hubo citas registradas hoy.*\n\n📌 No se registraron atenciones en el sistema para esta fecha.`;
      
      await enviarWhatsApp(fromFinal, toFinal, mensajeVacio, sid, token);
      return res.status(200).json({ success: true, message: "Sin citas hoy" });
    }

    // Procesar datos detallados
    let granTotal = 0;
    const servicios = {};
    const especialistas = {};
    
    citas.forEach(cita => {
      const f = cita.fields;
      const importe = parseFloat(f["Importe estimado"] || 0);
      const servicio = f.Servicio || "Sin especificar";
      const especialista = f.Especialista || "Sin asignar";
      
      granTotal += importe;
      
      // Acumular por servicio
      if (!servicios[servicio]) {
        servicios[servicio] = { cantidad: 0, total: 0 };
      }
      servicios[servicio].cantidad += 1;
      servicios[servicio].total += importe;
      
      // Acumular por especialista
      if (!especialistas[especialista]) {
        especialistas[especialista] = { citas: 0, ingresos: 0 };
      }
      especialistas[especialista].citas += 1;
      especialistas[especialista].ingresos += importe;
    });

    // Encontrar top especialista
    const topEspecialista = Object.entries(especialistas)
      .sort((a, b) => b[1].citas - a[1].citas)[0];
    
    // Calcular promedio por cita
    const promedioGeneral = granTotal / citas.length;

    // Construir mensaje profesional
    let mensaje = `📊 *AURA SYNC - Reporte Diario*\n`;
    mensaje += `━━━━━━━━━━━━━━━\n`;
    mensaje += `📅 ${fechaFormateada.toUpperCase()}\n\n`;
    
    // Resumen Ejecutivo
    mensaje += `*📈 RESUMEN EJECUTIVO*\n`;
    mensaje += `• Total Citas: ${citas.length}\n`;
    mensaje += `• Ingresos del Día: $${granTotal.toFixed(2)}\n`;
    mensaje += `• Promedio por Cita: $${promedioGeneral.toFixed(2)}\n\n`;
    
    // Desglose por Servicio
    mensaje += `*💇‍♀️ DETALLE POR SERVICIO*\n`;
    Object.entries(servicios).forEach(([nombre, datos]) => {
      const promedioServicio = datos.total / datos.cantidad;
      mensaje += `\n▪️ *${nombre}*\n`;
      mensaje += `   Citas: ${datos.cantidad}  |  $${datos.total.toFixed(2)}\n`;
      mensaje += `   Ticket prom.: $${promedioServicio.toFixed(2)}\n`;
    });
    
    mensaje += `\n`;
    
    // Top Especialista
    if (topEspecialista) {
      mensaje += `*⭐ ESPECIALISTA DESTACADO*\n`;
      mensaje += `👤 ${topEspecialista[0]}\n`;
      mensaje += `   ${topEspecialista[1].citas} citas | $${topEspecialista[1].ingresos.toFixed(2)}\n\n`;
    }
    
    // Cierre
    mensaje += `━━━━━━━━━━━━━━━\n`;
    mensaje += `*💰 GRAN TOTAL: $${granTotal.toFixed(2)}*\n`;
    mensaje += `━━━━━━━━━━━━━━━\n`;
    mensaje += `_Reporte generado automáticamente_`;

    await enviarWhatsApp(fromFinal, toFinal, mensaje, sid, token);
    
    return res.status(200).json({ 
      success: true, 
      citas: citas.length,
      total: granTotal 
    });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return res.status(500).json({ 
      error: "Error en envío", 
      detalle: error.response?.data || error.message 
    });
  }
}

// Función auxiliar para enviar WhatsApp
async function enviarWhatsApp(from, to, body, sid, token) {
  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', from);
  params.append('Body', body);

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
}
