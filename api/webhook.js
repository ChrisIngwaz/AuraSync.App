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

// ============ NUEVO: Configuración zona horaria Ecuador ============
const TIMEZONE = 'America/Guayaquil';

// ============ NUEVO: Obtener fecha actual en Ecuador ============
function getFechaEcuador(offsetDias = 0) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + offsetDias);
  return fecha.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// ============ NUEVO: Formatear fecha para mostrar ============
function formatearFecha(fechaISO) {
  const [anio, mes, dia] = fechaISO.split('-');
  const fecha = new Date(anio, mes - 1, dia);
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: TIMEZONE
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 ${userPhone}`);

  try {
    // 1. PROCESAR AUDIO/TEXTO (SIN CAMBIOS)
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

    // 2. CARGAR CLIENTE (SIN CAMBIOS)
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente?.nombre;
    const primerNombre = cliente?.nombre?.split(' ')[0] || null;

    // ============ NUEVO: Cargar última propuesta de cita si existe ============
    let ultimaPropuesta = null;
    if (!esNuevo) {
      const { data: ultimaCitaPendiente } = await supabase
        .from('citas_temp') // Tabla opcional para propuestas pendientes, o usar lógica de historial
        .select('*')
        .eq('telefono', userPhone)
        .eq('estado', 'propuesta')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      ultimaPropuesta = ultimaCitaPendiente;
    }

    // 3. RECUPERAR HISTORIAL (SIN CAMBIOS)
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
    } else {
      console.log('⚡ Cliente nuevo detectado.');
    }

    // 4. DATOS DE NEGOCIO (SIN CAMBIOS EN LA CONSULTA)
    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";

    // ============ NUEVO: Detectar intención del usuario ============
    const textoLower = textoUsuario.toLowerCase();
    const intencionCancelar = ['cancelar', 'anular', 'eliminar cita', 'quitar cita'].some(p => textoLower.includes(p));
    const intencionReagendar = ['cambiar', 'mover', 'otra hora', 'otra fecha', 'reagendar', 'reprogramar'].some(p => textoLower.includes(p));
    const intencionConfirmar = ['sí', 'si', 'ok', 'dale', 'perfecto', 'confirmo', 'sí, gracias', 'sí por favor'].some(p => textoLower === p || textoLower.startsWith(p + ' '));

    // 5. SYSTEM PROMPT (MEJORADO PERO CONSERVANDO ESENCIA)
    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Comunicación sofisticada, ejecutiva y proactiva.

[IDENTIDAD]
- Tono: Profesional, seguro, comercialmente astuto
- Proactividad: TOMA LA INICIATIVA en recomendaciones
- Cliente: ${cliente?.nombre || 'Nuevo Usuario'}

[CAPACIDADES - IMPORTANTE]
Puedes: AGENDAR nuevas citas, CANCELAR citas existentes, REAGENDAR cambiando fecha/hora.
Si el usuario quiere cambiar una cita: ayúdalo a reprogramar.
Si quiere cancelar: confirma la cancelación.

[RECOMENDACIONES]
- Especialistas: ${listaEsp}
- Servicios: ${catalogo}
- Destaca virtudes del equipo según expertise

[REGLAS DE ORO]
- NUNCA digas "No sé" o "Como usted prefiera"
- Evita lenguaje meloso. Negocios de alta gama.
- Si ya te dio un dato, úsalo para avanzar

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente:
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "...",
  "cita_id": "..." // Para cancelar/reagendar, ID de cita existente
}`;

    // 6. CONSTRUIR MENSAJES PARA AI (SIN CAMBIOS)
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

    // 7. PROCESAR JSON Y EJECUTAR ACCIÓN
    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // ============ REGISTRO CLIENTE NUEVO (SIN CAMBIOS) ============
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || "",
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          cliente = { nombre: datosExtraidos.nombre, apellido: datosExtraidos.apellido || "" };
        }

        // ============ NUEVO: Determinar acción ============
        const accion = datosExtraidos.accion || 'none';
        
        // ============ NUEVO: CANCELAR CITA ============
        if (accion === 'cancelar' || intencionCancelar) {
          const resultado = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
          mensajeAccion = resultado 
            ? "✅ Cita cancelada exitosamente." 
            : "No encontré citas activas para cancelar. ¿Tienes una cita agendada?";
          accionEjecutada = true;
        }
        
        // ============ NUEVO: REAGENDAR CITA ============
        else if (accion === 'reagendar' || intencionReagendar) {
          if (datosExtraidos.cita_fecha && datosExtraidos.cita_hora) {
            const resultado = await reagendarCitaAirtable(userPhone, datosExtraidos);
            mensajeAccion = resultado 
              ? `✅ Cita reprogramada para ${formatearFecha(datosExtraidos.cita_fecha)} a las ${datosExtraidos.cita_hora}.`
              : "No pude reprogramar. ¿Tienes una cita activa?";
            accionEjecutada = true;
          }
        }
        
        // ============ AGENDAR CITA (MEJORADO) ============
        else if (accion === 'agendar' || (datosExtraidos.cita_fecha && datosExtraidos.cita_hora)) {
          const tieneFecha = datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
          const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
          
          if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre)) {
            
            // ============ NUEVO: Buscar datos reales del servicio ============
            let servicioData = servicios?.find(s => 
              s.nombre.toLowerCase() === (datosExtraidos.cita_servicio || '').toLowerCase()
            ) || servicios?.find(s => 
              (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())
            ) || { nombre: datosExtraidos.cita_servicio || "Servicio", precio: 0, duracion: 60 };

            // ============ NUEVO: Verificar disponibilidad ============
            const disponible = await verificarDisponibilidadAirtable(
              datosExtraidos.cita_fecha,
              datosExtraidos.cita_hora,
              datosExtraidos.cita_especialista,
              servicioData.duracion
            );

            if (!disponible.ok) {
              // Sugerir alternativa
              const alternativa = await buscarAlternativaAirtable(
                datosExtraidos.cita_fecha,
                datosExtraidos.cita_hora,
                datosExtraidos.cita_especialista,
                servicioData.duracion,
                especialistas?.map(e => e.nombre)
              );
              
              mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
              accionEjecutada = true;
            } else {
              // Crear cita
              const citaCreada = await crearCitaAirtable({
                telefono: userPhone,
                nombre: cliente?.nombre || datosExtraidos.nombre,
                apellido: cliente?.apellido || datosExtraidos.apellido || "",
                fecha: datosExtraidos.cita_fecha,
                hora: datosExtraidos.cita_hora,
                servicio: servicioData.nombre,
                especialista: disponible.especialista || datosExtraidos.cita_especialista || "Asignar",
                precio: servicioData.precio,
                duracion: servicioData.duracion
              });

              if (citaCreada) {
                mensajeAccion = `✅ Cita confirmada: ${formatearFecha(datosExtraidos.cita_fecha)} a las ${datosExtraidos.cita_hora} con ${disponible.especialista || datosExtraidos.cita_especialista || 'nuestro equipo'}.`;
              } else {
                mensajeAccion = "Tuve un problema registrando la cita. ¿Lo intentamos de nuevo?";
              }
              accionEjecutada = true;
            }
          }
        }

      } catch (e) { 
        console.error('Error procesando JSON:', e.message); 
      }
    }

    // 8. FINALIZAR RESPUESTA (ADAPTADO)
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    // ============ NUEVO: Si se ejecutó acción, usar mensaje de confirmación ============
    if (accionEjecutada && mensajeAccion) {
      cleanReply = mensajeAccion;
    } else if (accionEjecutada) {
      cleanReply += `\n\n${mensajeAccion}`;
    }

    // Guardar conversación (SIN CAMBIOS)
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento de distracción. ¿Me repites por favor? 🌸</Message></Response>');
  }
}

// ============ FUNCIÓN EXISTENTE: Crear cita (MEJORADA) ============
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
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion
        }
      }]
    };
    await axios.post(url, payload, { 
      headers: { 
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });
    return true;
  } catch (error) { 
    console.error('Error Airtable:', error.message);
    return false; 
  }
}

// ============ NUEVO: Cancelar cita ============
async function cancelarCitaAirtable(telefono, citaId) {
  try {
    // Buscar cita activa por teléfono
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return false;

    const recordId = citaId || busqueda.data.records[0].id;
    
    await axios.patch(`${url}`, {
      records: [{
        id: recordId,
        fields: { "Estado": "Cancelada" }
      }]
    }, {
      headers: { 
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });
    
    return true;
  } catch (error) {
    console.error('Error cancelando:', error.message);
    return false;
  }
}

// ============ NUEVO: Reagendar cita ============
async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return false;

    const recordId = datos.cita_id || busqueda.data.records[0].id;
    
    await axios.patch(`${url}`, {
      records: [{
        id: recordId,
        fields: { 
          "Fecha": datos.cita_fecha,
          "Hora": datos.cita_hora,
          "Especialista": datos.cita_especialista || busqueda.data.records[0].fields.Especialista,
          "Estado": "Confirmada"
        }
      }]
    }, {
      headers: { 
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });
    
    return true;
  } catch (error) {
    console.error('Error reagendando:', error.message);
    return false;
  }
}

// ============ NUEVO: Verificar disponibilidad ============
async function verificarDisponibilidadAirtable(fecha, hora, especialistaSolicitado, duracionMinutos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    
    // Buscar citas ese día
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const citas = response.data.records;
    
    // Convertir hora a minutos para comparar
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracionMinutos || 60);

    // Horario laboral: 9:00 - 18:00
    if (inicioNuevo < 540) { // 9:00
      return { ok: false, mensaje: "Nuestro horario comienza a las 9:00. ¿Te funciona?" };
    }
    if (finNuevo > 1080) { // 18:00
      return { ok: false, mensaje: "Ese horario excede nuestra jornada (hasta 18:00). ¿Otra hora?" };
    }

    // Verificar conflictos
    for (const cita of citas) {
      const horaExistente = cita.fields.Hora;
      const duracionExistente = cita.fields['Duración estimada (minutos)'] || 60;
      const espExistente = cita.fields.Especialista;
      
      const [he, me] = horaExistente.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + duracionExistente;

      // Hay traslape y mismo especialista
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialistaSolicitado || espExistente === especialistaSolicitado) {
          return { 
            ok: false, 
            mensaje: `${espExistente} no está disponible a las ${hora}. ¿Otra hora u otro especialista?`,
            conflicto: true 
          };
        }
      }
    }

    // Si llegó aquí, está disponible
    return { 
      ok: true, 
      especialista: especialistaSolicitado || (citas.length > 0 ? null : 'Asignar')
    };

  } catch (error) {
    console.error('Error verificando disponibilidad:', error.message);
    // Si falla la verificación, permitir (mejor perder una cita que perder un cliente)
    return { ok: true, especialista: especialistaSolicitado };
  }
}

// ============ NUEVO: Buscar alternativa ============
async function buscarAlternativaAirtable(fecha, horaSolicitada, especialistaSolicitado, duracion, listaEspecialistas) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const citas = response.data.records;
    const ocupados = citas.map(c => ({
      hora: c.fields.Hora,
      duracion: c.fields['Duración estimada (minutos)'] || 60,
      especialista: c.fields.Especialista
    }));

    // Buscar siguiente slot disponible desde hora solicitada
    const [h, m] = horaSolicitada.split(':').map(Number);
    let horaPropuesta = h * 60 + m;
    
    while (horaPropuesta <= 1080 - duracion) { // Hasta cierre
      const finPropuesta = horaPropuesta + duracion;
      let conflicto = false;
      
      for (const ocup of ocupados) {
        const [ho, mo] = ocup.hora.split(':').map(Number);
        const inicioOcupado = ho * 60 + mo;
        const finOcupado = inicioOcupado + ocup.duracion;
        
        if (horaPropuesta < finOcupado && finPropuesta > inicioOcupado) {
          if (!especialistaSolicitado || ocup.especialista === especialistaSolicitado) {
            conflicto = true;
            break;
          }
        }
      }
      
      if (!conflicto) {
        const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
        return {
          mensaje: `¿Te funciona a las ${horaStr}?`,
          hora: horaStr
        };
      }
      
      horaPropuesta += 15; // Saltos de 15 min
    }

    return {
      mensaje: "Ese día está completo. ¿Otro día quizás?"
    };

  } catch (error) {
    return { mensaje: "¿Te funciona otro horario?" };
  }
}
