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

const TIMEZONE = 'America/Guayaquil';

// ============ FUNCIONES DE FECHA ============

function getFechaEcuador(offsetDias = 0) {
  const ahoraUTC = new Date();
  const offsetMs = -5 * 60 * 60 * 1000;
  const ahoraEcuador = new Date(ahoraUTC.getTime() + offsetMs);
  ahoraEcuador.setDate(ahoraEcuador.getDate() + offsetDias);
  return ahoraEcuador.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO;
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

// ============ FUNCIÓN: Sugerir especialistas persuasivamente ============

function generarSugerenciaEspecialistas(especialistas, servicioSolicitado) {
  if (!especialistas || especialistas.length === 0) {
    return "Te recomiendo a **nuestro equipo de especialistas**, todos certificados con estándares internacionales.";
  }
  
  const seleccionados = especialistas.slice(0, 2);
  
  const sugerencias = seleccionados.map(esp => {
    let mensaje = "";
    
    if (servicioSolicitado?.toLowerCase().includes('corte') || servicioSolicitado?.toLowerCase().includes('cabello')) {
      if (esp.expertise?.toLowerCase().includes('color')) {
        mensaje = `**${esp.nombre}** — experto en colorimetría y tendencias. Sus degradados son impecables y duraderos, perfectos para quienes buscan un look moderno y sofisticado.`;
      } else if (esp.expertise?.toLowerCase().includes('corte')) {
        mensaje = `**${esp.nombre}** — especialista en cortes estructurales. Tiene un ojo único para los ángulos que favorecen cada tipo de rostro, creando estilos personalizados que realzan tu belleza natural.`;
      } else {
        mensaje = `**${esp.nombre}** — ${esp.expertise || 'estilista experto'} con técnicas de alta precisión y años de experiencia transformando looks.`;
      }
    } 
    else if (servicioSolicitado?.toLowerCase().includes('manicura') || servicioSolicitado?.toLowerCase().includes('uña')) {
      if (esp.expertise?.toLowerCase().includes('art') || esp.expertise?.toLowerCase().includes('diseño')) {
        mensaje = `**${esp.nombre}** — artista en manicuras. Sus diseños son miniaturas perfectas que duran semanas intactas, ideal si buscas algo único y creativo.`;
      } else if (esp.expertise?.toLowerCase().includes('spa') || esp.expertise?.toLowerCase().includes('tratamiento')) {
        mensaje = `**${esp.nombre}** — experto en tratamientos de spa para manos. Su técnica de masaje relajante es única, perfecta para una experiencia de cuidado completo.`;
      } else {
        mensaje = `**${esp.nombre}** — ${esp.expertise || 'especialista en cuidado de uñas'} con acabados impecables y atención meticulosa al detalle.`;
      }
    }
    else if (servicioSolicitado?.toLowerCase().includes('facial') || servicioSolicitado?.toLowerCase().includes('tratamiento')) {
      mensaje = `**${esp.nombre}** — ${esp.expertise || 'especialista en tratamientos faciales'}. Su enfoque holístico deja la piel radiante y revitalizada desde la primera sesión.`;
    }
    else {
      mensaje = `**${esp.nombre}** — ${esp.expertise || 'profesional de élite'}. Clientes VIP lo solicitan específicamente por su atención personalizada y resultados excepcionales.`;
    }
    
    return mensaje;
  });
  
  return sugerencias.join('\n\n');
}

// ============ FUNCIONES AIRTABLE ============

async function obtenerCitasOcupadas(fecha) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    return response.data.records.map(r => ({
      hora: r.fields.Hora,
      duracion: r.fields['Duración estimada (minutos)'] || 60,
      especialista: r.fields.Especialista
    }));
  } catch (error) {
    console.error('Error consultando Airtable:', error.message);
    return [];
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
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion,
          "ID_Supabase": datos.supabase_id
        }
      }]
    };
    
    console.log('📤 Airtable - Fecha:', datos.fecha, 'Hora:', datos.hora);
    
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

async function cancelarCitaAirtable(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return false;

    const record = busqueda.data.records[0];
    await axios.patch(url, {
      records: [{ id: record.id, fields: { "Estado": "Cancelada" } }]
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (record.fields.ID_Supabase) {
      await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', record.fields.ID_Supabase);
    }
    return true;
  } catch (error) {
    console.error('Error cancelando:', error.message);
    return false;
  }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return false;

    const record = busqueda.data.records[0];
    await axios.patch(url, {
      records: [{
        id: record.id,
        fields: {
          "Fecha": datos.cita_fecha,
          "Hora": datos.cita_hora,
          "Especialista": datos.cita_especialista || record.fields.Especialista
        }
      }]
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (record.fields.ID_Supabase) {
      await supabase.from('citas')
        .update({ fecha_hora: `${datos.cita_fecha}T${datos.cita_hora}:00-05:00` })
        .eq('id', record.fields.ID_Supabase);
    }
    return true;
  } catch (error) {
    console.error('Error reagendando:', error.message);
    return false;
  }
}

// ============ VERIFICACIÓN DE DISPONIBILIDAD ============

async function verificarDisponibilidad(fecha, hora, especialistaSolicitado, duracionMinutos, citasOcupadas) {
  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracionMinutos || 60);

  if (inicioNuevo < 540) {
    return { ok: false, mensaje: "Nuestro horario comienza a las 9:00. ¿Te funciona?" };
  }
  if (finNuevo > 1080) {
    return { ok: false, mensaje: "Ese horario excede nuestra jornada. ¿Otra hora?" };
  }

  for (const cita of citasOcupadas) {
    const [he, me] = cita.hora.split(':').map(Number);
    const inicioExistente = he * 60 + me;
    const finExistente = inicioExistente + cita.duracion;

    if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
      if (!especialistaSolicitado || cita.especialista === especialistaSolicitado) {
        return {
          ok: false,
          mensaje: `${cita.especialista} no está disponible a las ${hora}. ¿Otra hora u otro especialista?`,
          conflicto: true
        };
      }
    }
  }

  return { ok: true, especialista: especialistaSolicitado };
}

// ============ WEBHOOK PRINCIPAL ============

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : '';

  if (!userPhone) {
    return res.status(200).send('<Response></Response>');
  }

  try {
    // 1. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es",
          { url: MediaUrl0 },
          {
            headers: {
              'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Disculpa, no pude escuchar bien. ¿Me escribes? 🎙️</Message></Response>');
      }
    }

    // 2. CARGAR DATOS
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    // 3. CALCULAR FECHAS
    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);
    
    const textoLower = textoUsuario.toLowerCase();
    const mencionaManana = textoLower.includes('mañana') || textoLower.includes('manana');
    const mencionaHoy = textoLower.includes('hoy');
    
    const fechaReferencia = mencionaManana ? fechaManana : fechaHoy;

    // 4. CONSULTAR AGENDA
    const citasOcupadas = await obtenerCitasOcupadas(fechaReferencia);

    // Cargar historial
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(6);

    const historialFormateado = historial?.reverse().map(h => 
      `${h.rol === 'user' ? 'Cliente' : 'Aura'}: ${h.contenido}`
    ).join('\n') || '';

    // 5. SYSTEM PROMPT PERSUASIVO Y HUMANIZADO
    const systemPrompt = `Eres Aura, coordinadora de lujo de AuraSync. Tu misión: hacer sentir al cliente VIP desde el primer mensaje y agendar con estilo.

[ESTILO DE COMUNICACIÓN]
- NUNCA digas "No sé" o "Como prefieras". Eres experta, guías tú con elegancia.
- Lenguaje cálido pero ejecutivo: "Perfecto", "Excelente elección", "Te tengo una propuesta ideal".
- Siempre destaca el valor: calidad, exclusividad, atención personalizada.
- Usa emojis con moderación y elegancia.

[DATOS DEL DÍA]
- Hoy: ${formatearFecha(fechaHoy)}
- Mañana: ${formatearFecha(fechaManana)}
- Fecha de referencia para esta conversación: ${formatearFecha(fechaReferencia)}
- Citas ocupadas: ${citasOcupadas.length > 0 ? citasOcupadas.map(c => `${c.hora} con ${c.especialista}`).join(', ') : 'Ninguna'}

[ESPECIALISTAS DISPONIBLES]
${especialistas?.map(e => `- ${e.nombre}: ${e.expertise}`).join('\n')}

[SERVICIOS]
${servicios?.map(s => `- ${s.nombre}`).join('\n')}

[HISTORIAL RECIENTE]
${historialFormateado}

[REGLAS DE ORO]
1. PRIMER MENSAJE: Si el cliente pide cita pero NO especifica especialista, SUGIERE 2 opciones destacando su expertise con persuasión suave. NO agendes todavía.
2. Si el cliente ELIGE especialista (ej: "Carlos", "el primero", "Ricardo"), ENTONCES confirma la cita completa.
3. Si el horario solicitado está ocupado: Propón la siguiente hora disponible inmediata.
4. Solo confirma cita cuando el cliente acepte explícitamente o elija especialista.
5. Nunca pidas datos que ya tienes (nombre, teléfono).

[FORMATO JSON FINAL]
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "nombre exacto del servicio",
  "cita_especialista": "nombre exacto del especialista",
  "necesita_sugerencia": true | false,
  "especialista_elegido": true | false
}`;

    // 6. LLAMADA A OPENAI
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.4,
      max_tokens: 500
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let reply = aiRes.data.choices[0].message.content;
    console.log('📝 Respuesta OpenAI:', reply.substring(0, 200));

    // 7. PROCESAR RESPUESTA
    const jsonMatch = reply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})/);
    let data = {};
    let accionEjecutada = false;
    let mensajeFinal = reply.split('DATA_JSON')[0].trim();

    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
        
        // Registrar cliente nuevo
        if (data.nombre && !cliente?.nombre) {
          const { data: nuevoCliente } = await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: data.nombre,
            apellido: data.apellido || "",
            created_at: new Date().toISOString()
          }, { onConflict: 'telefono' }).select().single();
          
          cliente = nuevoCliente;
        }

        // USAR SIEMPRE fechaReferencia (calculada del mensaje del usuario)
        let fechaFinal = fechaReferencia;

        // Buscar servicio y especialista
        const servicio = servicios?.find(s => 
          s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())
        );
        
        const especialista = especialistas?.find(e => 
          e.nombre.toLowerCase().includes((data.cita_especialista || '').toLowerCase())
        );

        // ============ PERSUASIÓN: Sugerir especialistas ============
        if (data.necesita_sugerencia || (!data.cita_especialista || data.cita_especialista === "...")) {
          const sugerencia = generarSugerenciaEspecialistas(especialistas, data.cita_servicio);
          mensajeFinal = `¡${cliente?.nombre || 'Hola'}! ${data.cita_servicio ? `Un **${data.cita_servicio}** es una excelente elección.` : 'Qué bueno que quieras agendar con nosotros.'}\n\nTe propongo estos especialistas:\n\n${sugerencia}\n\n¿Con quién te gustaría reservar? Estoy aquí para asegurarte una experiencia exclusiva. ✨`;
          accionEjecutada = false;
        }

        // ============ AGENDAR ============
        else if (data.accion === 'agendar' && data.cita_hora && data.cita_especialista && servicio && especialista) {
          
          const disponible = await verificarDisponibilidad(
            fechaFinal,
            data.cita_hora,
            data.cita_especialista,
            servicio.duracion,
            citasOcupadas
          );

          if (!disponible.ok) {
            mensajeFinal = disponible.mensaje;
          } else {
            // 🔥 CORREGIDO: Usar fecha_hora (timestamp) en lugar de campos separados
            const { data: citaSupabase, error: errorSupabase } = await supabase
              .from('citas')
              .insert({
                cliente_id: cliente?.id,
                servicio_id: servicio.id,
                especialista_id: especialista.id,
                fecha_hora: `${fechaFinal}T${data.cita_hora}:00-05:00`,  // Formato ISO con zona horaria Ecuador
                estado: 'Confirmada',
                created_at: new Date().toISOString()
              })
              .select()
              .single();

            if (errorSupabase) {
              console.error('Error Supabase:', errorSupabase);
              throw errorSupabase;
            }

            // Crear en Airtable (fecha y hora separadas)
            await crearCitaAirtable({
              telefono: userPhone,
              nombre: cliente?.nombre || data.nombre,
              apellido: cliente?.apellido || data.apellido || "",
              fecha: fechaFinal,
              hora: data.cita_hora,
              servicio: servicio.nombre,
              especialista: especialista.nombre,
              precio: servicio.precio,
              duracion: servicio.duracion,
              supabase_id: citaSupabase?.id
            });

            mensajeFinal = `✅ ¡Excelente elección, ${cliente?.nombre || data.nombre || ''}! Tu cita está confirmada:\n\n📅 ${formatearFecha(fechaFinal)} a las ${data.cita_hora}\n💇‍♀️ ${servicio.nombre}\n👤 Con ${especialista.nombre}\n\nTe esperamos con los brazos abiertos para consentirte. ✨`;
            accionEjecutada = true;
          }
        }
        
        // ============ CANCELAR ============
        else if (data.accion === 'cancelar') {
          const resultado = await cancelarCitaAirtable(userPhone);
          mensajeFinal = resultado 
            ? "✅ He cancelado tu cita. ¿Te gustaría agendar otra?"
            : "No encontré citas activas para cancelar.";
          accionEjecutada = true;
        }
        
        // ============ REAGENDAR ============
        else if (data.accion === 'reagendar') {
          const resultado = await reagendarCitaAirtable(userPhone, { ...data, cita_fecha: fechaFinal });
          mensajeFinal = resultado
            ? `✅ Cita actualizada para ${formatearFecha(fechaFinal)} a las ${data.cita_hora}.`
            : "No pude actualizar. ¿Tienes una cita activa?";
          accionEjecutada = true;
        }

      } catch (e) {
        console.error('Error procesando:', e.message);
        mensajeFinal = "Disculpa, tuve un problema. ¿Me repites?";
      }
    }

    // 8. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: mensajeFinal, created_at: new Date().toISOString() }
    ]);

    // 9. RESPONDER
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${mensajeFinal}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error crítico:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento. ¿Me repites? 🌸</Message></Response>');
  }
}
