import axios from 'axios';

export default async function handler(req, res) {
  try {
    // 1. Validar variables de entorno
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Faltan credenciales de Twilio');
    }
    if (!process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_TOKEN) {
      throw new Error('Faltan credenciales de Airtable');
    }

    const sid = process.env.TWILIO_ACCOUNT_SID.trim();
    const token = process.env.TWILIO_AUTH_TOKEN.trim();
    
    const twilioNumber = process.env.TWILIO_NUMBER?.trim().replace('whatsapp:', '') || '14155238886';
    const fromFinal = `whatsapp:${twilioNumber}`;

    // 2. LISTA DE DESTINATARIOS (Dueño y Administrador)
    const destinatarios = [
      'whatsapp:+593995430859', // Dueño
      'whatsapp:+593XXXXXXXXX'  // CAMBIA ESTO por el número del Administrador
    ];

    // 3. Obtener fecha actual en Ecuador
    const ahora = new Date();
    const opciones = { 
      timeZone: 'America/Guayaquil',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    };
    
    const formatter = new Intl.DateTimeFormat('en-CA', opciones);
    const hoy = formatter.format(ahora); 
    
    const fechaFormateada = ahora.toLocaleDateString('es-EC', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      timeZone: 'America/Guayaquil'
    });

    // 4. Consulta a Airtable
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableName = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || 'Citas');
    const formula = `{Fecha} = '${hoy}'`;
    const encodedFormula = encodeURIComponent(formula);
    
    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${tableName}?filterByFormula=${encodedFormula}`;
    
    const airtableRes = await axios.get(airtableUrl, {
      headers: { 
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const citas = airtableRes.data.records || [];
    let mensaje = "";

    // 5. Construir el mensaje
    if (citas.length === 0) {
      mensaje = `📊 *AURA SYNC - Reporte Diario*\n\n📅 ${fechaFormateada}\n\n⚠️ *No hubo citas registradas hoy.*\n\n📌 No se registraron atenciones en el sistema para esta fecha.`;
    } else {
      let granTotal = 0;
      const servicios = {};
      const especialistas = {};
      
      citas.forEach((cita) => {
        const f = cita.fields;
        const importe = parseFloat(f["Importe estimado"] || 0);
        const servicio = f.Servicio || "Sin especificar";
        const especialista = f.Especialista || "Sin asignar";
        
        granTotal += importe;
        
        if (!servicios[servicio]) servicios[servicio] = { cantidad: 0, total: 0 };
        servicios[servicio].cantidad += 1;
        servicios[servicio].total += importe;
        
        if (!especialistas[especialista]) especialistas[especialista] = { citas: 0, ingresos: 0 };
        especialistas[especialista].citas += 1;
        especialistas[especialista].ingresos += importe;
      });

      mensaje = `📊 *AURA SYNC - Reporte Diario*\n`;
      mensaje += `━━━━━━━━━━━━━━━\n`;
      mensaje += `📅 ${fechaFormateada.toUpperCase()}\n\n`;
      mensaje += `*📈 RESUMEN EJECUTIVO*\n`;
      mensaje += `• Total Citas: ${citas.length}\n`;
      mensaje += `• Ingresos del Día: $${granTotal.toFixed(2)}\n`;
      mensaje += `• Promedio por Cita: $${(granTotal / citas.length).toFixed(2)}\n\n`;
      mensaje += `*💇‍♀️ DETALLE POR SERVICIO*\n`;
      
      Object.entries(servicios).forEach(([nombre, datos]) => {
        mensaje += `\n▪️ *${nombre}*\n`;
        mensaje += `   Citas: ${datos.cantidad}  |  $${datos.total.toFixed(2)}\n`;
      });
      
      mensaje += `\n`;
      const topEspecialista = Object.entries(especialistas).sort((a, b) => b[1].citas - a[1].citas)[0];
      if (topEspecialista) {
        mensaje += `*⭐ ESPECIALISTA DESTACADO*\n`;
        mensaje += `👤 ${topEspecialista[0]}\n`;
        mensaje += `   ${topEspecialista[1].citas} citas | $${topEspecialista[1].ingresos.toFixed(2)}\n\n`;
      }
      mensaje += `━━━━━━━━━━━━━━━\n`;
      mensaje += `*💰 GRAN TOTAL: $${granTotal.toFixed(2)}*\n`;
      mensaje += `━━━━━━━━━━━━━━━\n`;
      mensaje += `_Reporte generado automáticamente_`;
    }

    // 6. ENVIAR A TODOS LOS DESTINATARIOS
    const envios = destinatarios.map(numero => 
      enviarWhatsApp(fromFinal, numero, mensaje, sid, token)
    );
    
    await Promise.all(envios);
    
    return res.status(200).json({ success: true, message: "Reportes enviados correctamente" });

  } catch (error) {
    console.error('Error en reporte:', error.message);
    return res.status(500).json({ error: "Error en envío", detalle: error.message });
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
