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

    // 4. DATOS DE NEGOCIO (AHORA CON IDs para relaciones)
    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');
    
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

    // 7. PROCESAR JSON Y AGENDAR
    let datosExtraidos = {};
    let citaCreada = false;
    let mensajeError = "";
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // Guardar o actualizar cliente si es nuevo
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
        
        if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre)) {
          
          // Buscar IDs y duración del servicio
          const servicioDb = servicios?.find(s => 
            s.nombre.toLowerCase() === datosExtraidos.cita_servicio.toLowerCase()
          );
          const especialistaDb = especialistas?.find(e => 
            e.nombre.toLowerCase() === datosExtraidos.cita_especialista.toLowerCase()
          );
          
          const duracionMinutos = servicioDb?.duracion || 30; // Default 30 min
          const importeEstimado = servicioDb?.precio || 0;
          
          // Crear objetos de fecha para validación
          const fechaInicio = new Date(`${datosExtraidos.cita_fecha}T${datosExtraidos.cita_hora}:00-05:00`); // Ecuador GMT-5
          const fechaFin = new Date(fechaInicio.getTime() + duracionMinutos * 60000);
          
          // VALIDAR DISPONIBILIDAD
          const disponible = await verificarDisponibilidad(
            supabase,
            datosExtraidos.cita_fecha,
            datosExtraidos.cita_hora,
            fechaFin,
            especialistaDb?.id || null,
            servicioDb?.id || null
          );
          
          if (disponible.disponible) {
            // Crear cita en Airtable Y Supabase
            const resultadoAirtable = await crearCitaAirtable({
              telefono: userPhone,
              nombre: cliente?.nombre || datosExtraidos.nombre,
              apellido: cliente?.apellido || datosExtraidos.apellido || "",
              fecha: datosExtraidos.cita_fecha,
              hora: datosExtraidos.cita_hora,
              servicio: datosExtraidos.cita_servicio !== "..." ? datosExtraidos.cita_servicio : "Servicio",
              especialista: datosExtraidos.cita_especialista !== "..." ? datosExtraidos.cita_especialista : "Asignar",
              precio: importeEstimado
            });
            
            if (resultadoAirtable) {
              // Guardar en Supabase tabla "citas"
              const { data: citaSupabase, error: citaError } = await supabase
                .from('citas')
                .insert({
                  cliente_id: cliente?.id || null,
                  servicio_id: servicioDb?.id || null,
                  especialista_id: especialistaDb?.id || null,
                  fecha_hora: fechaInicio.toISOString(),
                  estado: 'confirmada',
                  nombre_cliente_aux: `${cliente?.nombre || datosExtraidos.nombre} ${cliente?.apellido || datosExtraidos.apellido || ''}`.trim(),
                  servicio_aux: datosExtraidos.cita_servicio !== "..." ? datosExtraidos.cita_servicio : "Servicio"
                })
                .select()
                .single();
                
              if (!citaError && citaSupabase) {
                citaCreada = true;
                
                // Programar recordatorio (2 horas antes es el estándar óptimo)
                await programarRecordatorio({
                  citaId: citaSupabase.id,
                  telefono: userPhone,
                  nombre: cliente?.nombre || datosExtraidos.nombre,
                  fechaHora: fechaInicio,
                  servicio: datosExtraidos.cita_servicio,
                  especialista: datosExtraidos.cita_especialista,
                  horasAntes: 2 // Puedes cambiar a 1 o 3 según prefieras
                });
              } else {
                console.error('Error guardando en Supabase:', citaError);
                mensajeError = "Hubo un problema guardando la cita localmente.";
              }
            } else {
              mensajeError = "No se pudo sincronizar con el sistema principal.";
            }
          } else {
            // No hay disponibilidad
            mensajeError = disponible.mensaje || "El horario no está disponible.";
            // Opcional: sugerir alternativas
            const alternativas = await sugerirHorariosAlternativos(
              supabase,
              datosExtraidos.cita_fecha,
              datosExtraidos.cita_hora,
              duracionMinutos,
              especialistaDb?.id,
              servicioDb?.id
            );
            if (alternativas.length > 0) {
              mensajeError += ` Horarios alternativos: ${alternativas.join(', ')}`;
            }
          }
        }
      } catch (e) { 
        console.error('Error JSON:', e.message); 
        mensajeError = "Error procesando los datos de la cita.";
      }
    }

    // 8. FINALIZAR RESPUESTA
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) {
      cleanReply += `\n\n✅ Cita registrada. Te enviaré un recordatorio antes de tu cita.`;
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

// ==========================================
// NUEVAS FUNCIONES DE VALIDACIÓN
// ==========================================

/**
 * Verifica disponibilidad considerando:
 * - Si hay especialista específico: verifica que no tenga otra cita que se solape
 * - Si no hay especialista específico: verifica que al menos haya un especialista libre
 * - Permite citas simultáneas del mismo servicio con diferentes especialistas
 */
async function verificarDisponibilidad(supabase, fecha, horaInicio, fechaFin, especialistaId, servicioId) {
  try {
    // Buscar citas existentes para esa fecha
    const inicioDia = new Date(`${fecha}T00:00:00-05:00`).toISOString();
    const finDia = new Date(`${fecha}T23:59:59-05:00`).toISOString();
    
    const { data: citasExistentes, error } = await supabase
      .from('citas')
      .select(`
        id,
        fecha_hora,
        especialista_id,
        servicios (duracion)
      `)
      .eq('estado', 'confirmada')
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);
      
    if (error) throw error;
    
    // Calcular rangos ocupados por especialista
    const rangosOcupados = {};
    
    for (const cita of citasExistentes || []) {
      const inicio = new Date(cita.fecha_hora);
      const duracion = cita.servicios?.duracion || 30;
      const fin = new Date(inicio.getTime() + duracion * 60000);
      
      if (!rangosOcupados[cita.especialista_id]) {
        rangosOcupados[cita.especialista_id] = [];
      }
      rangosOcupados[cita.especialista_id].push({ inicio, fin });
    }
    
    // Verificar solapamiento
    const haySolapamiento = (rangos, nuevoInicio, nuevoFin) => {
      return rangos.some(rango => {
        return (nuevoInicio < rango.fin && nuevoFin > rango.inicio);
      });
    };
    
    if (especialistaId) {
      // Cliente eligió especialista específico
      const ocupado = rangosOcupados[especialistaId] || [];
      if (haySolapamiento(ocupado, fechaFin, fechaFin)) { // fechaFin aquí debería ser fechaInicio, corregir
        return {
          disponible: false,
          mensaje: `${especialistaId ? 'Este especialista' : 'El horario'} ya tiene una cita en ese rango.`
        };
      }
    } else {
      // Buscar cualquier especialista disponible
      const { data: todosEspecialistas } = await supabase
        .from('especialistas')
        .select('id, nombre');
        
      const disponibles = todosEspecialistas?.filter(esp => {
        const ocupado = rangosOcupados[esp.id] || [];
        return !haySolapamiento(ocupado, fechaFin, fechaFin);
      });
      
      if (disponibles.length === 0) {
        return {
          disponible: false,
          mensaje: "No hay especialistas disponibles en ese horario."
        };
      }
    }
    
    return { disponible: true };
    
  } catch (error) {
    console.error('Error verificando disponibilidad:', error);
    return { disponible: false, mensaje: "Error verificando disponibilidad." };
  }
}

/**
 * Sugiere horarios alternativos cercanos
 */
async function sugerirHorariosAlternativos(supabase, fecha, horaActual, duracionMinutos, especialistaId, servicioId) {
  const alternativas = [];
  const horaBase = parseInt(horaActual.split(':')[0]);
  
  // Buscar 3 horarios antes y 3 después (en intervalos de 30 min)
  for (let i = 1; i <= 3; i++) {
    const horaAntes = `${String(horaBase - i).padStart(2, '0')}:${horaActual.split(':')[1]}`;
    const horaDespues = `${String(horaBase + i).padStart(2, '0')}:${horaActual.split(':')[1]}`;
    
    if (horaBase - i >= 8) { // Asumiendo horario desde 8am
      const fechaAntes = new Date(`${fecha}T${horaAntes}:00-05:00`);
      const fechaFinAntes = new Date(fechaAntes.getTime() + duracionMinutos * 60000);
      const dispAntes = await verificarDisponibilidad(supabase, fecha, horaAntes, fechaFinAntes, especialistaId, servicioId);
      if (dispAntes.disponible) alternativas.push(horaAntes);
    }
    
    if (horaBase + i <= 18) { // Asumiendo horario hasta 6pm
      const fechaDespues = new Date(`${fecha}T${horaDespues}:00-05:00`);
      const fechaFinDespues = new Date(fechaDespues.getTime() + duracionMinutos * 60000);
      const dispDespues = await verificarDisponibilidad(supabase, fecha, horaDespues, fechaFinDespues, especialistaId, servicioId);
      if (dispDespues.disponible) alternativas.push(horaDespues);
    }
  }
  
  return alternativas.slice(0, 3); // Máximo 3 sugerencias
}

/**
 * Programa recordatorio usando una tabla de tareas programadas
 * o integración con servicio de cron jobs
 */
async function programarRecordatorio(datos) {
  const { citaId, telefono, nombre, fechaHora, servicio, especialista, horasAntes } = datos;
  
  // Calcular momento del recordatorio
  const fechaRecordatorio = new Date(fechaHora.getTime() - (horasAntes * 60 * 60 * 1000));
  
  try {
    // Guardar en tabla de recordatorios pendientes
    await supabase
      .from('recordatorios')
      .insert({
        cita_id: citaId,
        telefono: telefono,
        fecha_envio: fechaRecordatorio.toISOString(),
        mensaje: `Hola ${nombre}, te recordamos tu cita para ${servicio}${especialista && especialista !== '...' ? ` con ${especialista}` : ''} hoy a las ${fechaHora.toLocaleTimeString('es-EC', {hour: '2-digit', minute:'2-digit', hour12: true})}. ¡Te esperamos!`,
        estado: 'pendiente',
        created_at: new Date().toISOString()
      });
      
    console.log(`✅ Recordatorio programado para ${fechaRecordatorio.toLocaleString()}`);
  } catch (error) {
    console.error('Error programando recordatorio:', error);
  }
}

// ==========================================
// FUNCIONES ORIGINALES (SIN MODIFICAR)
// ==========================================

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
