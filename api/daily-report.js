import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

export default async function handler(req, res) {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Faltan credenciales de Twilio');
    }

    const sid = process.env.TWILIO_ACCOUNT_SID.trim();
    const token = process.env.TWILIO_AUTH_TOKEN.trim();
    
    const twilioNumber = process.env.TWILIO_NUMBER?.trim().replace('whatsapp:', '') || '14155238886';
    const fromFinal = `whatsapp:${twilioNumber}`;
    
    // ═══════════════════════════════════════════════════════════════
    // FECHA DE HOY EN ECUADOR (formato YYYY-MM-DD)
    // ═══════════════════════════════════════════════════════════════
    const ahora = new Date();
    const opciones = { 
      timeZone: 'America/Guayaquil',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    };
    
    const formatter = new Intl.DateTimeFormat('en-CA', opciones);
    const hoy = formatter.format(ahora); // "2026-04-21"
    
    const fechaFormateada = ahora.toLocaleDateString('es-EC', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long',
      timeZone: 'America/Guayaquil'
    });

    // ═══════════════════════════════════════════════════════════════
    // FUENTE DE VERDAD: SUPABASE (no Airtable)
    // ═══════════════════════════════════════════════════════════════
    const inicioDia = `${hoy}T00:00:00`;
    const finDia = `${hoy}T23:59:59`;

    const { data: citasSupabase, error: errorSupabase } = await supabase
      .from('citas')
      .select(`
        id,
        fecha_hora,
        estado,
        servicio_aux,
        duracion_aux,
        nombre_cliente_aux,
        especialista_id,
        servicios:servicio_id ( nombre, precio ),
        especialistas:especialista_id ( nombre ),
        clientes:cliente_id ( nombre, apellido, telefono )
      `)
      .in('estado', ['Confirmada', 'Completada'])
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia)
      .order('fecha_hora', { ascending: true });

    if (errorSupabase) {
      throw new Error(`Error Supabase: ${errorSupabase.message}`);
    }

    const citas = citasSupabase || [];

    // ═══════════════════════════════════════════════════════════════
    // CONSTRUIR MENSAJE DEL REPORTE
    // ═══════════════════════════════════════════════════════════════
    let mensaje = "";
    
    if (citas.length === 0) {
      mensaje = `📊 *AURA SYNC - Reporte Diario*\n\n📅 ${fechaFormateada.toUpperCase()}\n\n⚠️ *No hubo citas registradas hoy.*\n\n📌 No se registraron atenciones confirmadas en el sistema para esta fecha.`;
    } else {
      let granTotal = 0;
      const servicios = {};
      const especialistas = {};
      
      citas.forEach((cita) => {
        // Precio: primero de la relación servicios, luego fallback
        const precioServicio = cita.servicios?.precio || 0;
        const precio = precioServicio || 0;
        
        const servicio = cita.servicio_aux || cita.servicios?.nombre || "Sin especificar";
        const especialista = cita.especialistas?.nombre || "Sin asignar";
        const estado = cita.estado || "Confirmada";
        
        if (estado === "Confirmada" || estado === "Completada") {
          granTotal += precio;
          
          if (!servicios[servicio]) {
            servicios[servicio] = { cantidad: 0, total: 0 };
          }
          servicios[servicio].cantidad += 1;
          servicios[servicio].total += precio;
          
          if (!especialistas[especialista]) {
            especialistas[especialista] = { citas: 0, ingresos: 0 };
          }
          especialistas[especialista].citas += 1;
          especialistas[especialista].ingresos += precio;
        }
      });

      mensaje = `📊 *AURA SYNC - Reporte Diario*\n`;
      mensaje += `━━━━━━━━━━━━━━━\n`;
      mensaje += `📅 ${fechaFormateada.toUpperCase()}\n\n`;
      
      mensaje += `*📈 RESUMEN EJECUTIVO*\n`;
      mensaje += `• Total Citas: ${citas.length}\n`;
      mensaje += `• Ingresos Estimados: $${granTotal.toFixed(2)}\n`;
      mensaje += `• Promedio por Cita: $${citas.length > 0 ? (granTotal / citas.length).toFixed(2) : '0.00'}\n\n`;
      
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
      mensaje += `_Reporte generado automáticamente por Aura_`;
    }

    // ═══════════════════════════════════════════════════════════════
    // ENVIAR REPORTE (Dueño y Administrador — corrige números duplicados)
    // ═══════════════════════════════════════════════════════════════
    const destinatarios = [
      'whatsapp:+593995430859',      // Dueño
      // 'whatsapp:+593XXXXXXXXX'     // Administrador (agregar cuando tenga número distinto)
    ];

    // Eliminar duplicados por si acaso
    const destinatariosUnicos = [...new Set(destinatarios)];

    for (const to of destinatariosUnicos) {
      try {
        await enviarWhatsApp(fromFinal, to, mensaje, sid, token);
      } catch (err) {
        console.error(`❌ Error enviando reporte a ${to}:`, err.message);
      }
    }
    
    return res.status(200).json({ 
      success: true, 
      total: citas.length, 
      fecha: hoy,
      fuente: 'Supabase (fuente de verdad)'
    });

  } catch (error) {
    console.error('❌ Error en reporte:', error);
    
    // Intentar notificar al dueño del error del reporte
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID.trim();
      const token = process.env.TWILIO_AUTH_TOKEN.trim();
      const twilioNumber = process.env.TWILIO_NUMBER?.trim().replace('whatsapp:', '') || '14155238886';
      const fromFinal = `whatsapp:${twilioNumber}`;
      const to = 'whatsapp:+593995430859';
      
      const mensajeError = `⚠️ *AURA SYNC - Alerta*\n\nEl reporte diario de hoy falló al generarse.\n\nError: ${error.message}\n\nPor favor revisa el dashboard manualmente.`;
      await enviarWhatsApp(fromFinal, to, mensajeError, sid, token);
    } catch (e) {
      console.error('No se pudo enviar alerta de error:', e.message);
    }
    
    return res.status(500).json({ error: "Error en envío", detalle: error.message });
  }
}

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
      }, 
      timeout: 15000 
    }
  );
}
