import axios from 'axios';

export default async function handler(req, res) {
  try {
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
    
    // LISTA DE DESTINATARIOS (Dueño y Administrador)
    const destinatarios = [
      'whatsapp:+593995430859', // Dueño
      'whatsapp:+593995430859'  // Administrador (Asegúrate de poner el número real)
    ];

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
        
        if (!servicios[servicio]) {
          servicios[servicio] = { cantidad: 0, total: 0 };
        }
        servicios[servicio].cantidad += 1;
        servicios[servicio].total += importe;
        
        if (!especialistas[especialista]) {
          especialistas[especialista] = { citas: 0, ingresos: 0 };
        }
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
      
      const topEspecialista = Object.entries(especialistas)
        .sort((a, b) => b[1].citas - a[1].citas)[0];
      
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

    // Enviar a todos los destinatarios
    for (const to of destinatarios) {
      try {
        await enviarWhatsApp(fromFinal, to, mensaje, sid, token);
      } catch (err) {
        console.error(`Error enviando reporte a ${to}:`, err.message);
      }
    }
    
    return res.status(200).json({ success: true, total: citas.length, fecha: hoy });

  } catch (error) {
    return res.status(500).json({ error: "Error en envío", detalle: error.message });
  }
}

async function enviarWhatsApp(from, to, body, sid, token) {
  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', from);
  params.append('Body', body);
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    params.toString(),
    { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
}
