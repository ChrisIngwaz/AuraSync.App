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

// ============ FUNCIONES AUXILIARES DE TIEMPO ============

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
 * Verifica disponibilidad considerando especialista_id y duración real
 */
async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
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

    // Buscar citas existentes para ese especialista y fecha
    const { data: citasExistentes, error } = await supabase
      .from('citas')
      .select('fecha_hora, duracion_aux, servicio_aux')
      .eq('especialista_id', especialistaId)
      .eq('fecha_hora::date', fecha)  // Cast a date para comparar solo la fecha
      .in('estado', ['Confirmada', 'En proceso']);

    if (error) throw error;

    for (const cita of citasExistentes || []) {
      const horaExistente = cita.fecha_hora.substring(11, 16); // Extraer HH:MM
      const inicioExistente = timeToMinutes(horaExistente);
      const duracionExistente = cita.duracion_aux || 60;
      const finExistente = inicioExistente + duracionExistente;

      if (inicioNueva < finExistente && finNueva > inicioExistente) {
        return {
          disponible: false,
          mensaje: `Ya tenemos una cita de "${cita.servicio_aux}" a las ${horaExistente} (${duracionExistente} min). ¿Prefieres otro horario o especialista?`
        };
      }
    }

    return { disponible: true, mensaje: null };
  } catch (error) {
    console.error('Error verificando disponibilidad:', error);
    return { disponible: true, mensaje: null }; // Fallback seguro
  }
}

/**
 * Obtiene IDs de servicio y especialista por nombre
 */
async function obtenerIdsRelacionales(servicioNombre, especialistaNombre) {
  try {
    let servicioId = null;
    let especialistaId = null;
    let duracion = 60;
    let precio = 0;

    // Buscar servicio
    if (servicioNombre && servicioNombre !== '...') {
      const { data: serv } = await supabase
        .from('servicios')
        .select('id, duracion, precio')
        .ilike('nombre', servicioNombre)
        .maybeSingle();
      
      if (serv) {
        servicioId = serv.id;
        duracion = serv.duracion || 60;
        precio = serv.precio || 0;
      }
    }

    // Buscar especialista
    if (especialistaNombre && especialistaNombre !== '...' && especialistaNombre !== 'Asignar') {
      const { data: esp } = await supabase
        .from('especialistas')
        .select('id')
        .ilike('nombre', especialistaNombre)
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
 * Crea cita en Supabase adaptado a tu esquema relacional
 */
async function crearCitaSupabase(datos) {
  try {
    // Combinar fecha y hora en timestamp
    const fechaHora = `${datos.fecha}T${datos.hora}:00`;

    const { data, error } = await supabase
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

    if (error) {
      // Si es error de FK (servicio/especialista no existe), intentamos sin FKs como fallback
      if (error.code === '23503') {
        console.warn('FK no encontrada, guardando con auxiliares nulos');
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('citas')
          .insert({
            cliente_id: datos.clienteId,
            fecha_hora: fechaHora,
            estado: 'Confirmada',
            nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(),
            servicio_aux: datos.servicio,
            duracion_aux: datos.duracion
          })
          .select()
          .single();
        
        if (fallbackError) throw fallbackError;
        console.log('✅ Cita guardada en Supabase (modo fallback):', fallbackData.id);
        return true;
      }
      throw error;
    }

    console.log('✅ Cita guardada en Supabase:', data.id);
    return true;
  } catch (error) {
    console.error('❌ Error guardando en Supabase:', error.message);
    return false;
  }
}

// ============ HANDLER PRINCIPAL ============

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

    // 2. CARGAR CLIENTE (incluyendo ID para la relación)
    let { data: cliente } = await supabase
      .from('clientes')
      .select('id, nombre, apellido, fecha_nacimiento')  // Agregado 'id'
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente?.nombre;

    // 3. RECUPERAR HISTORIAL
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

    // 4. DATOS DE NEGOCIO
    const { data: especialistas } = await supabase.from('especialistas').select('nombre');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogoDetallado = servicios?.map(s => 
      `${s.nombre} ($${s.precio}, ${s.duracion} min)`
    ).join(', ') || "servicios";
    
    // 5. SYSTEM PROMPT
    const ahora = new Date();
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Guayaquil'
    }).format(ahora);
    const anioActual = ahora.getFullYear();

    const systemPrompt = `Tu nombre es Aura. Eres la coordinadora ejecutiva de AuraSync. Hablas como una profesional experta que conoce el negocio perfectamente: directa, cálida, eficiente y con seguridad en cada palabra. No eres un asistente virtual, eres parte del equipo.

[REGLAS DE CONVERSACIÓN]
1. NATURALIDAD: Responde con empatía. Si el cliente pide una cita, confirma que hay espacio (sin mencionarle al cliente que estás consultando), antes de pedir más datos. No uses frases prefabricadas.
2. ASESORÍA SUTIL: Solo sugiere tratamientos adicionales si la conversación fluye hacia ello o si el cliente menciona un problema. No lo fuerces al inicio.
3. ESPECIALISTAS: Si el cliente no menciona a nadie, dile quiénes están disponibles y pregúntale con quién prefiere atenderse. Presenta a Carlos y Anita como tus compañeros expertos.
   * Especialistas: ${listaEsp}.
4. LENGUAJE: Sofisticado pero cercano. Evita el tono robótico. Eres el brazo derecho del local.

[REGLAS DE ORO - NUNCA ROMPAS]
1. NUNCA digas "déjame verificar", "un momento", "estoy consultando", "permíteme revisar" o "déjame checar". Eso suena a robot de banco. Tú SABES la información o la gestionas directamente sin anunciar procesos internos.
2. NUNCA combines pensamiento y acción en el mismo mensaje. No digas "Voy a revisar... [pausa ficticia]... ¡Sí hay espacio!" 
3. Lenguaje ejecutivo: Usa "Te agendo", "Confirmamos", "Queda listo", "Te anoto". NUNCA "Voy a intentar", "Espera mientras...", "Creo que puedo", "Déjame ver si hay espacio".

[FLUJO DE AGENDAMIENTO NATURAL]
Si el cliente solicita una cita:
- FALTAN DATOS: Pregunta lo que hace falta de forma conversacional. Ejemplo: "Perfecto, para mañana a las 11:00 tengo a Anita disponible. ¿Prefieres con ella o te gustaría otro horario con Marina?"
- YA TIENES TODO (fecha, hora, servicio, especialista): Confirma con seguridad absoluta: "Listo, te queda agendado para mañana a las 11:00 con Anita para Manicura Aura Express. ¿Confirmamos?"
- HAY CONFLICTO (el código te informará): Ofrece alternativas sin dramatizar: "A las 3:00 con Carlos ya tengo ocupado, pero te puedo ofrecer a las 4:00 o a las 3:00 con Elena. ¿Cuál prefieres?"

[ESPECIALISTAS Y SERVICIOS]
- Especialistas disponibles: ${listaEsp}
- Servicios con duración y precio: ${catalogoDetallado}
- Horario de atención: 9:00 a 18:00
- Si el cliente no menciona especialista, preséntalos como opciones naturales: "Para ese horario tengo a Carlos o a Anita. ¿Con quién te gustaría atenderte?"

[MANEJO DE OBJECIONES]
- Si piden un servicio no listado: "Específicamente de pedicura no tengo en el menú, pero puedo agendarte una atención personalizada para tus uñas. ¿Te funciona?"
- Si la hora está fuera de horario: "Atendemos de 9 a 6. ¿Te funciona a las 9:00 mañana o prefieres otro día?"

[CONTEXTO TEMPORAL]
- Hoy es ${hoyEcuador}. Año: ${anioActual}
- Calcula fechas naturales (mañana, pasado, el lunes que viene)

[ESTRUCTURA DE DATOS - INVISIBLE]
Extrae estos datos de la conversación y ponlos al final en JSON (el usuario no debe ver esto):
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

    // 7. PROCESAR JSON Y AGENDAR
    let datosExtraidos = {};
    let citaCreada = false;
    let mensajeErrorCita = null;
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // Crear/Actualizar cliente si es nuevo (necesitamos el ID para la cita)
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          const { data: nuevoCliente, error: clienteError } = await supabase
            .from('clientes')
            .upsert({
              telefono: userPhone,
              nombre: datosExtraidos.nombre.trim(),
              apellido: datosExtraidos.apellido || "",
              fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
            }, { onConflict: 'telefono' })
            .select()
            .single();

          if (!clienteError && nuevoCliente) {
            cliente = nuevoCliente;
          }
        }

        const tieneFecha = datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
        
        if (tieneFecha && tieneHora && cliente?.id) {
          
          // Obtener IDs relacionales y duración
          const ids = await obtenerIdsRelacionales(
            datosExtraidos.cita_servicio,
            datosExtraidos.cita_especialista !== "..." ? datosExtraidos.cita_especialista : null
          );

          // Verificar disponibilidad con los IDs reales
          const verificacion = await verificarDisponibilidad(
            datosExtraidos.cita_fecha,
            datosExtraidos.cita_hora,
            ids.especialistaId,
            ids.duracion
          );

          if (!verificacion.disponible) {
            mensajeErrorCita = verificacion.mensaje;
          } else {
            const datosCita = {
              clienteId: cliente.id,
              nombre: cliente.nombre || datosExtraidos.nombre,
              apellido: cliente.apellido || datosExtraidos.apellido || "",
              fecha: datosExtraidos.cita_fecha,
              hora: datosExtraidos.cita_hora,
              servicio: datosExtraidos.cita_servicio !== "..." ? datosExtraidos.cita_servicio : "Servicio",
              especialista: datosExtraidos.cita_especialista !== "..." ? datosExtraidos.cita_especialista : "Asignar",
              servicioId: ids.servicioId,
              especialistaId: ids.especialistaId,
              duracion: ids.duracion,
              precio: ids.precio
            };

            // Crear en Airtable (sin cambios)
            const citaAirtable = await crearCitaAirtable(datosCita);
            
            // Crear en Supabase (adaptado a tu esquema)
            const citaSupabase = await crearCitaSupabase(datosCita);

            citaCreada = citaAirtable; // Airtable sigue siendo fuente de verdad externa
            
            if (!citaSupabase) {
              console.warn('⚠️ Cita en Airtable pero falló registro local en Supabase');
            }
          }
        }
      } catch (e) { 
        console.error('Error procesando datos:', e.message); 
      }
    }

    // 8. RESPUESTA FINAL
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    if (mensajeErrorCita) {
      cleanReply += `\n\n${mensajeErrorCita}`;
    } else if (citaCreada) {
      cleanReply += `\n\n✅ Cita registrada correctamente.`;
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

// Airtable sin cambios (puedes agregar duración si quieres)
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
    return true;
  } catch (error) { 
    console.error('Error Airtable:', error.response?.data || error.message);
    return false; 
  }
}
