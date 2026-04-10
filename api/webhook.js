import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const TIMEZONE = 'America/Guayaquil';

// Obtener fecha actual en Ecuador sin desfases
function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
 
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
 
  const fecha = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
 
  return fecha.toISOString().split('T')[0];
}

// Formatear fecha para mensajes humanos
function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return fechaISO || 'fecha por confirmar';
  }
 
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
 
  return fecha.toLocaleDateString('es-EC', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

// Handler principal del Webhook
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';
 
  try {
    let textoUsuario = Body || "";
   
    // Procesar audio si existe
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es",
          { url: MediaUrl0 },
          {
            headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        return res.status(200).send('<Response><Message>Error con audio. Escribime por favor.</Message></Response>');
      }
    }

    // Obtener datos del cliente y especialistas/servicios
    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    const esNuevo = !cliente?.nombre;
    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
      if (mensajes) historialFiltrado = mensajes.reverse();
    }

    const listaEsp = especialistas?.map(e => `${e.nombre} (Experto en: ${e.expertise})`).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";

    // SYSTEM PROMPT - REGLA DE ORO PARA FLUIDEZ NATURAL
    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Tu comunicación debe ser indistinguible de la de un humano: cálida, elegante, natural y persuasiva.

[IDENTIDAD]
- Tono: Profesional pero cercano, sofisticado y conversacional.
- Personalidad: Eres una concierge de lujo muy humana.

[FLUJO DE CONVERSACIÓN - REGLA DE ORO]
Para que la conversación sea natural, NUNCA hagas más de una cosa a la vez. Sigue este flujo estrictamente:

1. FASE DE DESCUBRIMIENTO: Si el cliente pide cita, saluda cálidamente y pregunta qué servicio busca (si no lo dijo) o sugiere especialistas. NUNCA propongas horarios en este paso.
2. FASE DE PROPUESTA: Una vez elegido el especialista, propón UN SOLO horario concreto y pregunta si le queda bien.
3. FASE DE CONFIRMACIÓN: SOLO cuando el cliente acepte el horario (diga "sí", "dale", "perfecto", etc.), procedes a confirmar.

[RESTRICCIONES CRÍTICAS]
- NUNCA saludes, sugieras especialista y propongas horario en el mismo mensaje.
- NUNCA confirmes la cita (accion: agendar) hasta que el cliente haya dicho que SÍ al horario propuesto.
- Si el cliente aún no confirma el horario, usa "accion": "none".
- Mantén tus respuestas breves, como si estuvieras chateando por WhatsApp.

[FECHAS]
- Hoy es: ${formatearFecha(getFechaEcuador())}
- Mañana es: ${formatearFecha(getFechaEcuador(1))}

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente:
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "..."
}`;

    const messages = [{ role: "system", content: systemPrompt }];
    historialFiltrado.forEach(msg => messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';

    // Extracción robusta de JSON (soporta bloques de código markdown)
    const jsonMatch = fullReply.match(/(?:DATA_JSON\s*:?\s*)?(?:```json\s*)?(\{[\s\S]*?"accion"[\s\S]*?\})(?:\s*```)?/i);
   
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        const textoLower = (textoUsuario || '').toLowerCase();
        
        // Lógica de fechas (hoy/mañana)
        let fechaFinal = getFechaEcuador(1); // Default mañana
        if (textoLower.includes('hoy')) fechaFinal = getFechaEcuador(0);
        else if (datosExtraidos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/)) fechaFinal = datosExtraidos.cita_fecha;

        // Registro de cliente nuevo
        if (datosExtraidos.nombre && esNuevo) {
          await supabase.from('clientes').upsert({ telefono: userPhone, nombre: datosExtraidos.nombre.trim(), apellido: datosExtraidos.apellido || "" }, { onConflict: 'telefono' });
        }

        const accion = datosExtraidos.accion || 'none';
       
        if (accion === 'agendar') {
          const tieneHora = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);
          if (fechaFinal && tieneHora) {
            let servicioData = servicios?.find(s => s.nombre.toLowerCase().includes((datosExtraidos.cita_servicio || '').toLowerCase())) || { id: null, nombre: "Servicio", precio: 0, duracion: 60 };
            
            const disponible = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);

            if (!disponible.ok) {
              const alternativa = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);
              mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
            } else {
              const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
              
              // Guardar en Supabase
              const { data: citaSupabase } = await supabase.from('citas').insert({
                cliente_id: cliente?.id || null,
                servicio_id: servicioData.id || null,
                fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                estado: 'Confirmada',
                nombre_cliente_aux: `${datosExtraidos.nombre || cliente?.nombre} ${datosExtraidos.apellido || cliente?.apellido}`.trim(),
                servicio_aux: servicioData.nombre,
                duracion_aux: servicioData.duracion
              }).select().single();

              // Guardar en Airtable
              const citaAirtable = await crearCitaAirtable({
                telefono: userPhone,
                nombre: datosExtraidos.nombre || cliente?.nombre,
                apellido: datosExtraidos.apellido || cliente?.apellido,
                fecha: fechaFinal,
                hora: datosExtraidos.cita_hora,
                servicio: servicioData.nombre,
                especialista: especialistaFinal,
                precio: servicioData.precio,
                duracion: servicioData.duracion,
                supabase_id: citaSupabase?.id || null
              });

              if (citaAirtable) {
                mensajeAccion = `✅ Cita confirmada: ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora} con ${especialistaFinal}.`;
              } else {
                mensajeAccion = "Error registrando en Airtable.";
              }
            }
            accionEjecutada = true;
          }
        }
      } catch (e) { console.error('Error JSON:', e.message); }
    }

    // Limpieza de respuesta para WhatsApp (elimina JSON y bloques de código)
    let cleanReply = fullReply.split(/DATA_JSON|```json/i)[0].trim();
    if (accionEjecutada && mensajeAccion) cleanReply = `${cleanReply}\n\n${mensajeAccion}`;

    // Guardar conversación y responder
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problema. ¿Me repites por favor? 🌸</Message></Response>');
  }
}

// --- Funciones de Airtable (crearCitaAirtable, verificarDisponibilidadAirtable, etc.) se mantienen igual ---
