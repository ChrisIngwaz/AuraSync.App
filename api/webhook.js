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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 ${userPhone}`);

  try {
    // 1. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    
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
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Error con audio. Escribime por favor.</Message></Response>');
      }
    }

    // 2. CARGAR CLIENTE Y VALIDAR SI ES NUEVO
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente?.nombre;

    // 3. RECUPERAR HISTORIAL SÓLO SI EL CLIENTE EXISTE
    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(6);
      
      if (mensajes) {
        historialFiltrado = mensajes.reverse();
      }
    }

    // 4. DATOS DE NEGOCIO (MODIFICADO: agregamos 'id' a la selección)
    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre'); // AGREGADO: id
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion'); // AGREGADO: id
    
    const listaEsp = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";
    
    // 5. SYSTEM PROMPT - AURA (HUMANA Y PROFESIONAL)
    const ahora = new Date();
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Guayaquil'
    }).format(ahora);
    const anioActual = ahora.getFullYear();

    const systemPrompt = `Tu nombre es Aura, asistente profesional de AuraSync. Tu objetivo es brindar una atención cálida, ejecutiva y humana. No parezcas un software; habla como una persona que conoce su negocio.

[REGLAS DE CONVERSACIÓN]
1. NATURALIDAD: Responde con empatía. Si el cliente pide una cita, confirma que hay espacio antes de pedir más datos. No uses frases prefabricadas.
2. ASESORÍA SUTIL: Solo sugiere tratamientos adicionales si la conversación fluye hacia ello o si el cliente menciona un problema. No lo fuerces al inicio.
3. ESPECIALISTAS: Si el cliente no menciona a nadie, dile quiénes están disponibles y pregúntale con quién prefiere atenderse. Presenta a Carlos y Anita como tus compañeros expertos.
   * Especialistas: ${listaEsp}.
4. LENGUAJE: Sofisticado pero cercano. Evita el tono robótico. Eres el brazo derecho del local.

[CONTEXTO TEMPORAL]
- Hoy es ${hoyEcuador}. Año: ${anioActual}. 
- Calcula fechas (mañana, el lunes) basándote estrictamente en este día.

[ESTRUCTURA DE DATOS]
Llenar siempre el JSON al final de forma invisible. Si falta un dato, usa "...".
DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "..."
}`;

    // 6. CONSTRUIR MENSAJES PARA AI
    const messages = [{ role: "system", content: systemPrompt }];
    historialFiltrado.forEach(msg => {
      messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido });
    });
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 7. PROCESAR JSON Y AGENDAR (AGREGADO: Lógica completa de validación y guardado en Supabase)
    let datosExtraidos = {};
    let citaCreada = false;
    let mensajeError = ""; // AGREGADO
    
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // Guardar cliente nuevo si es necesario (CÓDIGO ORIGINAL INTACTO)
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || "",
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          cliente = { nombre: datosExtraidos.nombre, apellido: datosExtraidos.apellido }; 
        }

        const tieneFecha = datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
        
        // AGREGADO: Buscar IDs y duración del servicio
        const servicioDb = servicios?.find(s => 
          s.nombre.toLowerCase() === datosExtraidos.cita_servicio.toLowerCase()
        );
        const especialistaDb = especialistas?.find(e => 
          e.nombre.toLowerCase() === datosExtraidos.cita_especialista.toLowerCase()
        );
        
        const importeEstimado = servicioDb ? servicioDb.precio : 0;
        const duracionMinutos = servicioDb?.duracion || 30; // AGREGADO: Duración real o default 30min

        if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre) && servicioDb) {
          
          // AGREGADO: Calcular fecha inicio y fin
          const fechaInicio = new Date(`${datosExtraidos.cita_fecha}T${datosExtraidos.cita_hora}:00-05:00`);
          const fechaFin = new Date(fechaInicio.getTime() + duracionMinutos * 60000);
          
          // AGREGADO: Verificar disponibilidad antes de agendar
          const disponibilidad = await verificarDisponibilidad(
            supabase,
            datosExtraidos.cita_fecha,
            fechaInicio,
            fechaFin,
            especialistaDb?.id || null,
            servicioDb.id
          );
          
          if (disponibilidad.disponible) {
            // AGREGADO: Determinar especialista final (si no eligió, usamos el que quedó libre)
            const espFinalId = especialistaDb?.id || disponibilidad.especialistaId;
            const espFinalNombre = especialistaDb?.nombre || disponibilidad.especialistaNombre || "Por asignar";
            
            // CÓDIGO ORIGINAL: Crear en Airtable
            citaCreada = await crearCitaAirtable({
              telefono: userPhone,
              nombre: cliente?.nombre || datosExtraidos.nombre,
              apellido: cliente?.apellido || datosExtraidos.apellido || "",
              fecha: datosExtraidos.cita_fecha,
              hora: datosExtraidos.cita_hora,
              servicio: datosExtraidos.cita_servicio,
              especialista: espFinalNombre,
              precio: importeEstimado
            });
            
            // AGREGADO: Si se creó en Airtable, guardar en Supabase
            if (citaCreada) {
              const { error: errorCita } = await supabase.from('citas').insert({
                cliente_id: cliente?.id || null,
                servicio_id: servicioDb.id,
                especialista_id: espFinalId,
                fecha_hora: fechaInicio.toISOString(),
                estado: 'confirmada',
                nombre_cliente_aux: cliente?.nombre || datosExtraidos.nombre,
                servicio_aux: servicioDb.nombre,
                duracion_aux: duracionMinutos
              });
              
              if (errorCita) {
                console.error('Error guardando cita en Supabase:', errorCita);
                // No cambiamos citaCreada a false porque Airtable sí funcionó
              }
            }
          } else {
            // AGREGADO: No hay disponibilidad
            mensajeError = disponibilidad.mensaje;
            if (disponibilidad.alternativas?.length > 0) {
              mensajeError += ` Te sugiero: ${disponibilidad.alternativas.slice(0, 3).join(', ')}`;
            }
          }
        }
      } catch (e) { 
        console.error('Error JSON:', e.message); 
      }
    }

    // 8. FINALIZAR RESPUESTA (AGREGADO: Manejo de errores en la respuesta)
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) {
      cleanReply += `\n\n✅ Cita registrada.`;
    } else if (mensajeError) {
      cleanReply += `\n\n⚠️ ${mensajeError}`;
    }

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Error técnico.</Message></Response>');
  }
}

// FUNCIÓN ORIGINAL INTACTA
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
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio
        }
      }]
    };
    await axios.post(url, payload, { 
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) { 
    console.error('Error Airtable:', error.response?.data || error.message);
    return false; 
  }
}

// AGREGADO: Funciones nuevas para control de agenda
async function verificarDisponibilidad(supabase, fecha, nInicio, nFin, espId, servicioId) {
  try {
    const iDia = new Date(`${fecha}T00:00:00-05:00`).toISOString();
    const fDia = new Date(`${fecha}T23:59:59-05:00`).toISOString();
    
    const { data: citas, error } = await supabase
      .from('citas')
      .select(`
        fecha_hora,
        especialista_id,
        servicios: servicio_id (duracion)
      `)
      .eq('estado', 'confirmada')
      .gte('fecha_hora', iDia)
      .lte('fecha_hora', fDia);
      
    if (error) throw error;
    
    // Función para chequear solapamiento
    const seSolapan = (citaExistente) => {
      const exI = new Date(citaExistente.fecha_hora);
      const duracionEx = citaExistente.servicios?.duracion || 30;
      const exF = new Date(exI.getTime() + duracionEx * 60000);
      return (nInicio < exF && nFin > exI);
    };
    
    // Si hay especialista específico
    if (espId) {
      const ocupado = citas?.some(c => c.especialista_id === espId && seSolapan(c));
      if (ocupado) {
        return {
          disponible: false,
          mensaje: "Este especialista ya tiene una cita en ese horario. ¿Prefieres otro especialista u otro horario?",
          alternativas: await sugerirAlternativas(supabase, fecha, nInicio, nFin, citas, espId)
        };
      }
      return { disponible: true, especialistaId: espId };
    }
    
    // Buscar cualquier especialista libre
    const { data: todosEsp } = await supabase.from('especialistas').select('id, nombre');
    for (const esp of todosEsp || []) {
      const citasEsp = citas?.filter(c => c.especialista_id === esp.id) || [];
      if (!citasEsp.some(c => seSolapan(c))) {
        return { 
          disponible: true, 
          especialistaId: esp.id,
          especialistaNombre: esp.nombre
        };
      }
    }
    
    return { 
      disponible: false, 
      mensaje: "Todos nuestros especialistas están ocupados en ese horario.",
      alternativas: await sugerirAlternativas(supabase, fecha, nInicio, nFin, citas, null)
    };
    
  } catch (error) {
    console.error('Error verificando disponibilidad:', error);
    return { disponible: false, mensaje: "Error verificando agenda." };
  }
}

async function sugerirAlternativas(supabase, fecha, nInicio, nFin, citasExistentes, espIdExcluir) {
  const alternativas = [];
  const duracionCita = (nFin - nInicio) / 60000;
  const horaBase = nInicio.getHours();
  const minutos = String(nInicio.getMinutes()).padStart(2, '0');
  
  for (let offset = 1; offset <= 3; offset++) {
    for (const dir of [-1, 1]) {
      const nuevaHora = horaBase + (offset * dir);
      if (nuevaHora < 8 || nuevaHora > 18) continue;
      
      const horaStr = `${String(nuevaHora).padStart(2, '0')}:${minutos}`;
      const nuevaInicio = new Date(`${fecha}T${horaStr}:00-05:00`);
      const nuevaFin = new Date(nuevaInicio.getTime() + duracionCita * 60000);
      
      // Verificar si hay algún especialista libre a esta hora
      const { data: todosEsp } = await supabase.from('especialistas').select('id, nombre');
      const hayLibre = todosEsp?.some(esp => {
        if (espIdExcluir && esp.id === espIdExcluir) return false;
        const citasEsp = citasExistentes?.filter(c => c.especialista_id === esp.id) || [];
        return !citasEsp.some(c => {
          const exI = new Date(c.fecha_hora);
          const durEx = c.servicios?.duracion || 30;
          const exF = new Date(exI.getTime() + durEx * 60000);
          return (nuevaInicio < exF && nuevaFin > exI);
        });
      });
      
      if (hayLibre && !alternativas.includes(horaStr)) alternativas.push(horaStr);
    }
  }
  
  return alternativas.slice(0, 3);
}
