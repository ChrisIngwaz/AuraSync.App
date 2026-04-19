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

// --- FUNCIONES DE APOYO ---

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year')?.value || '2026';
  const month = parts.find(p => p.type === 'month')?.value || '1';
  const day = parts.find(p => p.type === 'day')?.value || '1';
  const fecha = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

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

function formatearHora(hora24) {
  if (!hora24) return '';
  const [h, m] = hora24.split(':').map(Number);
  const periodo = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

// ============ MAPEO DE EXPERTISE ============

const MAPEO_EXPERTISE = {
  'corte': ['corte', 'barbero', 'estilista', 'degradado', 'fade', 'taper', 'peluquero', 'cabello'],
  'tinte': ['color', 'tinte', 'mechas', 'balayage', 'colorista'],
  'manicura': ['manicura', 'manos', 'uñas', 'nail', 'gel', 'acrílico'],
  'pedicura': ['pedicura', 'pies', 'podología', 'spa pies'],
  'facial': ['facial', 'rostro', 'limpieza', 'tratamiento', 'piel'],
  'maquillaje': ['maquillaje', 'makeup', 'social', 'novia', 'evento'],
  'peinado': ['peinado', 'evento', 'volumen', 'recogido', 'ondas']
};

function puedeHacerServicio(especialista, servicioNombre) {
  if (!especialista?.expertise || !servicioNombre) return false;
  const servicioNorm = servicioNombre.toLowerCase();
  const expertiseNorm = especialista.expertise.toLowerCase();

  for (const [categoria, keywords] of Object.entries(MAPEO_EXPERTISE)) {
    if (servicioNorm.includes(categoria)) {
      return keywords.some(kw => expertiseNorm.includes(kw));
    }
  }
  return expertiseNorm.includes(servicioNorm) || servicioNorm.includes(expertiseNorm);
}

// ============ GENERADOR DE SUGERENCIAS ============

function generarSugerenciaEspecialistas(especialistasFiltrados, servicio, fecha, hora, cliente) {
  if (!especialistasFiltrados || especialistasFiltrados.length === 0) {
    return { tipo: 'error', mensaje: "Lo siento, no tenemos especialistas disponibles para ese servicio en este momento." };
  }

  const fechaTexto = formatearFecha(fecha);
  const horaTexto = formatearHora(hora);

  let mensaje = `¡${cliente?.nombre || 'Hola'}! ✨ Para tu **${servicio.nombre}** el **${fechaTexto}** a las **${horaTexto}**, tengo estas opciones:\n\n`;

  const recomendados = especialistasFiltrados.slice(0, 2);

  recomendados.forEach((esp, idx) => {
    const label = idx === 0 ? '🥇 Opción recomendada' : '🥈 Alternativa ideal';
    mensaje += `${label}:\n**${esp.nombre}** — ${esp.expertise}\n`;
    mensaje += `✅ Disponible para confirmar\n\n`;
  });

  mensaje += `¿Con quién prefieres? Dime el nombre o "primero/segundo" 👇`;

  return {
    tipo: 'sugerencia',
    mensaje,
    recomendados: recomendados.map(e => ({ id: e.id, nombre: e.nombre }))
  };
}

function mensajeConfirmacion(cliente, servicio, especialista, fecha, hora) {
  return `✅ ¡Confirmado ${cliente?.nombre || ''}! ✅\n\n📅 ${formatearFecha(fecha)} a las ${formatearHora(hora)}\n💇‍♀️ ${servicio.nombre}\n✨ Con ${especialista}\n\n¡Te esperamos! 😊✨`;
}

// ============ AIRTABLE OPERACIONES ============

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaUTC,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion,
          "ID_Supabase": datos.supabase_id || null
        }
      }]
    };
    await axios.post(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) {
    console.error('Error creando cita:', error.message);
    return false;
  }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    if (busqueda.data.records.length === 0) return false;

    const record = busqueda.data.records[0];
    const recordId = citaId || record.id;
    const supabaseId = record.fields.ID_Supabase;

    await axios.patch(`${url}`, {
      records: [{ id: recordId, fields: { "Estado": "Cancelada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (supabaseId) {
      await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', supabaseId);
    }

    return true;
  } catch (error) {
    console.error('Error al cancelar cita:', error.message);
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
    const recordId = datos.cita_id || record.id;
    const supabaseId = record.fields.ID_Supabase;

    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    await axios.patch(`${url}`, {
      records: [{ id: recordId, fields: { "Fecha": fechaUTC, "Hora": datos.cita_hora, "Estado": "Confirmada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (supabaseId) {
      await supabase.from('citas').update({ 
        fecha_hora: `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`,
        estado: 'Confirmada' 
      }).eq('id', supabaseId);
    }

    return true;
  } catch (error) {
    console.error('Error al reagendar cita:', error.message);
    return false;
  }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialistaSolicitado, duracionMinutos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    const citas = response.data.records;
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracionMinutos || 60);
    if (inicioNuevo < 540) return { ok: false, mensaje: "Nuestro horario comienza a las 9:00." };
    if (finNuevo > 1080) return { ok: false, mensaje: "Ese horario excede nuestra jornada." };
    for (const cita of citas) {
      const [he, me] = cita.fields.Hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + (cita.fields['Duración estimada (minutos)'] || 60);
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialistaSolicitado || cita.fields.Especialista === especialistaSolicitado) {
          return { ok: false, mensaje: `${cita.fields.Especialista} no está disponible.` };
        }
      }
    }
    return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
  } catch (error) {
    return { ok: true, especialista: especialistaSolicitado };
  }
}

async function buscarAlternativaAirtable(fecha, horaSolicitada, especialistaSolicitado, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    const ocupados = response.data.records.map((c) => ({
      hora: c.fields.Hora,
      duracion: c.fields['Duración estimada (minutos)'] || 60,
      especialista: c.fields.Especialista
    }));
    const [h, m] = horaSolicitada.split(':').map(Number);
    let horaPropuesta = h * 60 + m;
    while (horaPropuesta <= 1080 - duracion) {
      let conflicto = false;
      for (const ocup of ocupados) {
        const [ho, mo] = ocup.hora.split(':').map(Number);
        if (horaPropuesta < (ho * 60 + mo + ocup.duracion) && (horaPropuesta + duracion) > (ho * 60 + mo)) {
          if (!especialistaSolicitado || ocup.especialista === especialistaSolicitado) {
            conflicto = true; break;
          }
        }
      }
      if (!conflicto) {
        const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
        return { mensaje: `¿Te funciona a las ${horaStr}?`, hora: horaStr };
      }
      horaPropuesta += 15;
    }
    return { mensaje: "Ese día está completo." };
  } catch (error) {
    return { mensaje: "¿Te funciona otro horario?" };
  }
}

// ============ MEJORA 1: SINCRONIZACIÓN BIDIRECCIONAL ============

async function sincronizarDesdeAirtable(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    
    // Buscar citas canceladas en Airtable que tengan ID_Supabase
    const filter = encodeURIComponent(`AND({ID_Supabase}!='',OR({Estado}='Cancelada',{Estado}='Reprogramada'))`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    
    for (const record of response.data.records) {
      const supabaseId = record.fields.ID_Supabase;
      const estadoAirtable = record.fields.Estado;
      
      if (supabaseId) {
        // Verificar estado actual en Supabase
        const { data: citaSupa } = await supabase
          .from('citas')
          .select('estado')
          .eq('id', supabaseId)
          .single();
        
        // Solo actualizar si hay diferencia
        if (citaSupa && citaSupa.estado !== estadoAirtable) {
          await supabase
            .from('citas')
            .update({ estado: estadoAirtable })
            .eq('id', supabaseId);
          console.log(`Sincronizado: Cita ${supabaseId} → ${estadoAirtable}`);
        }
      }
    }
    return true;
  } catch (error) {
    console.error('Error sincronización:', error.message);
    return false;
  }
}

// ============ MEJORA 2: DETECCIÓN INTELIGENTE DE ESPECIALISTA ============

async function detectarEspecialistaElegido(textoUsuario, telefono, candidatos) {
  const textoLower = textoUsuario.toLowerCase().trim();
  
  // Patrones de elección directa
  for (const cand of candidatos) {
    const nombreLower = cand.nombre.toLowerCase();
    const primerNombre = nombreLower.split(' ')[0];
    const partes = nombreLower.split(' ');
    
    // Coincidencias exactas o parciales del nombre
    if (textoLower.includes(nombreLower) || 
        textoLower.includes(primerNombre) ||
        partes.some(p => textoLower.includes(p) && p.length > 3)) {
      return cand.nombre;
    }
  }
  
  // Patrones posicionales con contexto
  const esPrimero = /\b(primero|primera|1|uno|option 1|opción 1|el primero|la primera)\b/i.test(textoLower);
  const esSegundo = /\b(segundo|segunda|2|dos|option 2|opción 2|el segundo|la segunda)\b/i.test(textoLower);
  const esCualquiera = /\b(cualquiera|me da igual|quien sea|el que tengas|disponible| primera que tengas)\b/i.test(textoLower);
  
  if (esPrimero && candidatos[0]) return candidatos[0].nombre;
  if (esSegundo && candidatos[1]) return candidatos[1].nombre;
  if (esCualquiera && candidatos[0]) return candidatos[0].nombre;
  
  // Si solo hay uno y el usuario confirma genéricamente
  if (candidatos.length === 1 && /\b(sí|si|dale|ok|perfecto|bueno|va|listo)\b/i.test(textoLower)) {
    return candidatos[0].nombre;
  }
  
  return null;
}

// ============ MEJORA 3: SYSTEM PROMPT OPTIMIZADO ============

function construirSystemPrompt(cliente, especialistas, servicios) {
  const listaEsp = especialistas?.map(e => `${e.nombre} (Experto en: ${e.expertise})`).join(', ') || "nuestro equipo";
  const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";
  const nombreCliente = cliente?.nombre || '';
  
  return `Eres Aura, asistente de élite de AuraSync. Agendas citas de belleza/bienestar por WhatsApp de forma natural y humana.

[FLUJO OBLIGATORIO - NUNCA LO SALTES]

PASO 1 - RECOPILACIÓN: Si falta servicio, fecha u hora, pregunta lo que falta.
PASO 2 - SUGERENCIA: Cuando tengas servicio+fecha+hora pero NO especialista, sugiere 2 especialistas y pregunta "¿Con quién prefieres?". USA accion: "none".
PASO 3 - CONFIRMACIÓN: Solo cuando el usuario elija especialista (nombre, "primero", "segundo", "cualquiera"), confirma y USA accion: "agendar".

[REGLAS CRÍTICAS]

✓ Si el usuario dice "mañana a las 11 para pedicure", USA esos datos exactos. NO preguntes otra fecha/hora.
✓ NUNCA propongas horarios diferentes a los que pidió el usuario.
✓ NUNCA agendes (accion: "agendar") sin especialista confirmado.
✓ Mensajes cortos, máximo 2-3 oraciones. Tono cálido pero eficiente.
✓ Si hay elección pendiente de especialista, espera a que elija.

[INTENCIONES]

- Cancelar: "cancelar", "anular", "eliminar" → accion: "cancelar"
- Reagendar: "cambiar", "mover", "otro día", "reagendar" → accion: "reagendar"  
- Agendar: Solo cuando tengas todos los datos + especialista confirmado

[DATOS]
Especialistas: ${listaEsp}
Servicios: ${catalogo}
Hoy: ${formatearFecha(getFechaEcuador())}
Mañana: ${formatearFecha(getFechaEcuador(1))}

[RESPUESTA]
Responde de forma natural, breve y conversacional.

DATA_JSON:{
"accion": "none"|"agendar"|"cancelar"|"reagendar",
"nombre": "${nombreCliente}",
"apellido": "${cliente?.apellido || ''}",
"cita_fecha": "YYYY-MM-DD",
"cita_hora": "HH:MM",
"cita_servicio": "...",
"cita_especialista": "...",
"cita_id": "..."
}`;
}

// --- HANDLER PRINCIPAL ---

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    // Sincronizar estados desde Airtable primero
    await sincronizarDesdeAirtable(userPhone);
    
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
      } catch (error) {
        console.error('Error Deepgram:', error.message);
      }
    }

    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const { data: especialistas } = await supabase.from('especialistas').select('*');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    const esNuevo = !cliente?.nombre;
    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
      if (mensajes) historialFiltrado = mensajes.reverse();
    }

    // Construir prompt optimizado
    const systemPrompt = construirSystemPrompt(cliente, especialistas, servicios);

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
    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';
    const textoLower = (textoUsuario || '').toLowerCase();
    
    const jsonMatch = fullReply.match(/(?:DATA_JSON\s*:?\s*)?(?:```json\s*)?(\{[\s\S]*?"accion"[\s\S]*?\})(?:\s*```)?/i);

    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // Determinar fecha final
        let fechaFinal = getFechaEcuador(1); 
        if (textoLower.includes('hoy')) fechaFinal = getFechaEcuador(0);
        else if (datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/)) fechaFinal = datosExtraidos.cita_fecha;

        // Guardar datos del cliente si es nuevo
        if (datosExtraidos.nombre && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || ""
          }, { onConflict: 'telefono' });
        }

        const accion = datosExtraidos.accion || 'none';
       
        if (accion === 'cancelar') {
          const resultado = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
          mensajeAccion = resultado ? "✅ Cita cancelada exitosamente." : "No encontré citas activas para cancelar.";
          accionEjecutada = true;
        }
        else if (accion === 'reagendar') {
          if (fechaFinal && datosExtraidos.cita_hora) {
            let servicioData = (servicios?.find(s => (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())) || { id: null, nombre: "Servicio", precio: 0, duracion: 60 });
            const disponible = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);

            if (!disponible.ok) {
              const alternativa = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);
              mensajeAccion = `Ese horario no está disponible para reagendar. ${alternativa.mensaje}`;
            } else {
              const resultado = await reagendarCitaAirtable(userPhone, { ...datosExtraidos, cita_fecha: fechaFinal });
              mensajeAccion = resultado ? `✅ Cita reprogramada para ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora}.` : "No encontré una cita activa para reprogramar.";
            }
            accionEjecutada = true;
          }
        }
        else if (accion === 'agendar') {
          if (fechaFinal && datosExtraidos.cita_hora) {
            let servicioData = (servicios?.find(s => (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())) || { id: null, nombre: "Servicio", precio: 0, duracion: 60 });
            
            // Buscar si hay elección pendiente reciente
            const { data: pendienteRaw } = await supabase
              .from('conversaciones')
              .select('contenido, created_at')
              .eq('telefono', userPhone)
              .eq('rol', 'system')
              .ilike('contenido', 'PENDIENTE_ELECCION:%')
              .order('created_at', { ascending: false })
              .limit(1)
              .single();

            let especialistaFinal = datosExtraidos.cita_especialista;
            let candidatosPendientes = [];
            
            // Verificar si hay pendiente válido (menos de 10 minutos)
            if (pendienteRaw?.contenido) {
              const pendienteTime = new Date(pendienteRaw.created_at);
              const ahora = new Date();
              const diffMinutos = (ahora - pendienteTime) / 1000 / 60;
              
              if (diffMinutos < 10) {
                const pendiente = JSON.parse(pendienteRaw.contenido.replace('PENDIENTE_ELECCION:', ''));
                candidatosPendientes = pendiente.candidatos || [];
                
                // Detectar elección del usuario
                especialistaFinal = await detectarEspecialistaElegido(textoUsuario, userPhone, candidatosPendientes);
              }
            }

            // Si no hay especialista elegido, sugerir 2
            if (!especialistaFinal) {
              let candidatos = especialistas.filter(e => puedeHacerServicio(e, servicioData.nombre));
              
              if (candidatos.length < 2) {
                const usados = new Set(candidatos.map(c => c.id));
                const extras = especialistas.filter(e => !usados.has(e.id));
                candidatos = [...candidatos, ...extras].slice(0, 2);
              } else {
                candidatos = candidatos.sort(() => Math.random() - 0.5).slice(0, 2);
              }
              
              const sugerencia = generarSugerenciaEspecialistas(candidatos, servicioData, fechaFinal, datosExtraidos.cita_hora, { nombre: cliente?.nombre || datosExtraidos.nombre });
              mensajeAccion = sugerencia.mensaje;
              
              // Guardar pendiente
              await supabase.from('conversaciones').insert({
                telefono: userPhone,
                rol: 'system',
                contenido: `PENDIENTE_ELECCION:${JSON.stringify({
                  fecha: fechaFinal,
                  hora: datosExtraidos.cita_hora,
                  servicio: servicioData,
                  candidatos: candidatos.map(c => ({ id: c.id, nombre: c.nombre }))
                })}`,
                created_at: new Date().toISOString()
              });
              
              accionEjecutada = true;
            } else {
              // Verificar disponibilidad y agendar
              const disponible = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, especialistaFinal, servicioData.duracion);

              if (!disponible.ok) {
                const alternativa = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, especialistaFinal, servicioData.duracion);
                mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
              } else {
                // Crear cita en Supabase
                const { data: citaSupabase } = await supabase.from('citas').insert({
                  cliente_id: cliente?.id || null,
                  servicio_id: servicioData.id || null,
                  fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                  estado: 'Confirmada',
                  nombre_cliente_aux: `${datosExtraidos.nombre || cliente?.nombre} ${datosExtraidos.apellido || cliente?.apellido}`.trim(),
                  servicio_aux: servicioData.nombre,
                  duracion_aux: servicioData.duracion,
                  especialista_aux: especialistaFinal
                }).select().single();

                // Crear en Airtable
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
                  // Limpiar pendiente
                  await supabase.from('conversaciones')
                    .delete()
                    .eq('telefono', userPhone)
                    .eq('rol', 'system')
                    .ilike('contenido', 'PENDIENTE_ELECCION:%');
                    
                  mensajeAccion = mensajeConfirmacion(
                    { nombre: datosExtraidos.nombre || cliente?.nombre },
                    servicioData,
                    especialistaFinal,
                    fechaFinal,
                    datosExtraidos.cita_hora
                  );
                } else {
                  mensajeAccion = "Hubo un error registrando tu cita. Por favor intenta de nuevo.";
                }
              }
              accionEjecutada = true;
            }
          }
        }
      } catch (e) { 
        console.error('Error JSON:', e.message); 
      }
    }

    let cleanReply = fullReply.split(/DATA_JSON|```json/i)[0].trim();
    if (accionEjecutada && mensajeAccion) cleanReply = `${cleanReply}\n\n${mensajeAccion}`.trim();

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);
    
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problema. ¿Me repites por favor? 🌸</Message></Response>');
  }
}
