import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

// ============ TIME UTILITIES ============

function timeToMinutes(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * VERIFICA DISPONIBILIDAD (Fail-Closed Logic)
 */
async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    // If no specialist is assigned yet, we assume it's okay but we will assign one later
    if (!especialistaId || especialistaId === '...' || especialistaId === 'Asignar') {
      return { disponible: true, mensaje: null };
    }

    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    const HORA_APERTURA = 540;  // 9:00
    const HORA_CIERRE = 1080;   // 18:00

    if (inicioNueva < HORA_APERTURA || finNueva > HORA_CIERRE) {
      return { 
        disponible: false, 
        mensaje: `El horario ${hora} está fuera de nuestro horario de atención (9:00 - 18:00).` 
      };
    }

    // Search for existing appointments for that specialist on that day
    const { data: citasExistentes, error } = await supabase
      .from('citas')
      .select('fecha_hora, duracion_aux, servicio_aux')
      .eq('especialista_id', especialistaId)
      .eq('fecha_hora::date', fecha) 
      .in('estado', ['Confirmada', 'En proceso']);

    if (error) throw error;

    for (const cita of citasExistentes || []) {
      const horaExistente = cita.fecha_hora.substring(11, 16); 
      const inicioExistente = timeToMinutes(horaExistente);
      const duracionExistente = cita.duracion_aux || 60;
      const finExistente = inicioExistente + duracionExistente;

      // Overlap logic: (StartA < EndB) AND (EndA > StartB)
      if (inicioNueva < finExistente && finNueva > inicioExistente) {
        return {
          disponible: false,
          mensaje: `El especialista ya tiene una cita de "${cita.servicio_aux}" a las ${horaExistente}.`
        };
      }
    }

    return { disponible: true, mensaje: null };
  } catch (error) {
    console.error('Error verificando disponibilidad:', error);
    // CRITICAL: Fail-Closed. If we can't check, we assume it's NOT available to avoid double-booking.
    return { disponible: false, mensaje: "En este momento no puedo acceder al calendario. ¿Podrías darme un minuto o intentar otro horario?" };
  }
}

/**
 * RELATIONAL ID RESOLVER (Fuzzy-ish matching)
 */
async function obtenerIdsRelacionales(servicioNombre, especialistaNombre) {
  try {
    let servicioId = null;
    let especialistaId = null;
    let duracion = 60;
    let precio = 0;

    if (servicioNombre && servicioNombre !== '...') {
      const { data: serv } = await supabase
        .from('servicios')
        .select('id, duracion, precio')
        .ilike('nombre', `%${servicioNombre}%`) // Use wildcards for better matching
        .maybeSingle();
      
      if (serv) {
        servicioId = serv.id;
        duracion = serv.duracion || 60;
        precio = serv.precio || 0;
      }
    }

    if (especialistaNombre && especialistaNombre !== '...' && especialistaNombre !== 'Asignar') {
      const { data: esp } = await supabase
        .from('especialistas')
        .select('id')
        .ilike('nombre', `%${especialistaNombre}%`)
        .maybeSingle();
      
      if (esp) especialistaId = esp.id;
    }

    return { servicioId, especialistaId, duracion, precio };
  } catch (error) {
    console.error('Error obteniendo IDs:', error);
    return { servicioId: null, especialistaId: null, duracion: 60, precio: 0 };
  }
}

/**
 * CREATE APPOINTMENT (Single Source of Truth Flow)
 */
async function registrarCita(datos) {
  try {
    const fechaHora = `${datos.fecha}T${datos.hora}:00`;

    // 1. Write to SUPABASE first (Source of Truth)
    const { data, error: sError } = await supabase
      .from('citas')
      .insert({
        cliente_id: datos.clienteId,
        servicio_id: datos.servicioId,
        especialista_id: datos.especialistaId,
        fecha_hora: fechaHora,
        estado: 'Confirmada',
        nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(),
        servicio_aux: datos.servicio,
        duracion_aux: datos.duracion
      })
      .select()
      .single();

    if (sError) throw sError;

    // 2. Mirror to AIRTABLE (Secondary/Admin view)
    await crearCitaAirtable(datos);

    return { success: true, id: data.id };
  } catch (error) {
    console.error('❌ Error registrando cita:', error.message);
    return { success: false, error: error.message };
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": datos.fecha,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono || '',
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion
        }
      }]
    };
    await axios.post(url, payload, { 
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (error) { 
    console.error('Error Airtable Mirroring:', error.message);
    // We don't throw error here because Supabase already succeeded
  }
}

// ============ MAIN HANDLER ============

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  try {
    // 1. INPUT PROCESSING
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        return res.status(200).send('<Response><Message>Tuve un problema con el audio. ¿Podrías escribirme?</Message></Response>');
      }
    }

    // 2. CLIENT RETRIEVAL
    let { data: cliente } = await supabase
      .from('clientes')
      .select('id, nombre, apellido, fecha_nacimiento')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente;

    // 3. MEMORY/HISTORY
    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(6);
      if (mensajes) historialFiltrado = mensajes.reverse();
    }

    // 4. BUSINESS DATA
    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre, rol, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const especialistasList = especialistas?.map(e => `- ${e.nombre} (${e.rol}): ${e.expertise || 'Experto certificado'}`).join('\n') || "";
    const serviciosList = servicios?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ') || "";

    // 5. SYSTEM PROMPT (Refined for deterministic behavior)
    const ahora = new Date();
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil'
    }).format(ahora);

    const systemPrompt = `Tu nombre es Aura, la coordinadora ejecutiva de AuraSync. Eres profesional, directa, cálida y eficiente. 

[ESTILO DE COMUNICACIÓN]
- No eres un bot, eres parte del equipo. Usa: "Te agendo", "Confirmamos", "Queda listo".
- NUNCA digas: "Déjame revisar", "Un momento", "Consultando el sistema". Tú manejas la información con seguridad.
- Si el cliente pide una cita, PROPÓN el horario basándote en la disponibilidad. No confirmes que "está registrado" hasta que el sistema te lo valide.

[REGLAS CRÍTICAS]
1. NUNCA confirmes que una cita "ya está guardada" en tu respuesta de texto. Di: "Tengo espacio a las 10:00 con Anita, ¿te reservo ese lugar?".
2. Usa EXACTAMENTE los nombres de servicios y especialistas de la lista proporcionada.
3. Si falta un dato (fecha, hora, servicio), pídelo de forma natural.

[DATOS DEL NEGOCIO]
Especialistas:
${especialistasList}
Servicios:
${serviciosList}
Horario: 9:00 a 18:00. Hoy es ${hoyEcuador}.

[ESTRUCTURA DE SALIDA]
Al final de tu respuesta, si tienes los datos para una cita, agrega el bloque JSON:
DATA_JSON:{
  "nombre": "${cliente?.nombre || '...'} ",
  "apellido": "${cliente?.apellido || '...'} ",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "Nombre Exacto",
  "cita_especialista": "Nombre Exacto"
}`;

    // 6. AI EXECUTION
    const messages = [{ role: "system", content: systemPrompt }, ...historialFiltrado.map(m => ({ role: m.rol, content: m.contenido })), { role: "user", content: textoUsuario }];
    
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 7. DETERMINISTIC VALIDATION & REGISTRATION
    let finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        const datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // Handle new client registration
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          const { data: nuevoCliente } = await supabase.from('clientes').upsert({
            telefono: userPhone, nombre: datosExtraidos.nombre.trim(), apellido: datosExtraidos.apellido || ""
          }, { onConflict: 'telefono' }).select().single();
          cliente = nuevoCliente;
        }

        const tieneFecha = datosExtraidos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);

        if (tieneFecha && tieneHora && cliente?.id) {
          const ids = await obtenerIdsRelacionales(datosExtraidos.cita_servicio, datosExtraidos.cita_especialista);
          const verificacion = await verificarDisponibilidad(datosExtraidos.cita_fecha, datosExtraidos.cita_hora, ids.especialistaId, ids.duracion);

          if (!verificacion.disponible) {
            finalMessage += `\n\n${verificacion.mensaje} ¿Te gustaría intentar con otro horario?`;
          } else {
            const resCita = await registrarCita({
              clienteId: cliente.id,
              telefono: userPhone,
              nombre: cliente.nombre,
              apellido: cliente.apellido,
              fecha: datosExtraidos.cita_fecha,
              hora: datosExtraidos.cita_hora,
              servicio: datosExtraidos.cita_servicio,
              especialista: datosExtraidos.cita_especialista,
              servicioId: ids.servicioId,
              especialistaId: ids.especialistaId,
              duracion: ids.duracion,
              precio: ids.precio
            });

            if (resCita.success) {
              finalMessage += `\n\n✅ ¡Listo! Tu cita ha quedado confirmada en nuestro sistema.`;
            } else {
              finalMessage += `\n\nHubo un problema técnico al guardar. ¿Podemos intentar de nuevo?`;
            }
          }
        }
      } catch (e) { console.error('JSON Error:', e); }
    }

    // 8. FINAL RESPONSE & MEMORY
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: finalMessage }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${finalMessage}</Message></Response>`);

  } catch (err) {
    console.error('Global Error:', err);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problema técnico. ¿Podrías repetirme eso?</Message></Response>');
  }
}
