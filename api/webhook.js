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

// ============ UTILIDADES ============

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

function formatearHora(hora24) {
  if (!hora24) return '';
  const [h, m] = hora24.split(':').map(Number);
  const periodo = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

// ============ LÓGICA DE NEGOCIO CRÍTICA ============

function puedeRealizarServicio(especialista, nombreServicio) {
  if (!especialista || !nombreServicio) return false;
  
  const servicioLower = nombreServicio.toLowerCase();
  const expertiseLower = (especialista.expertise || '').toLowerCase();
  
  // Mapeo estricto servicio -> expertise requerido
  const reglas = {
    'pedicura': ['pedicura', 'pies', 'podología', 'spa pies', 'manicure y pedicure', 'uñas pies'],
    'manicura': ['manicura', 'manos', 'nail art', 'uñas', 'gel', 'acrílico'],
    'corte': ['corte', 'barbero', 'estilista', 'peluquero', 'degradado', 'fade', 'taper', 'cabello'],
    'tinte': ['color', 'tinte', 'mechas', 'balayage', 'decoloración', 'colorista'],
    'facial': ['facial', 'limpieza facial', 'tratamiento facial', 'dermo', 'estética facial'],
    'masaje': ['masaje', 'spa', 'terapeuta', 'relajación', 'drenaje'],
    'maquillaje': ['maquillaje', 'makeup', 'social', 'novia', 'eventos'],
    'cejas': ['cejas', 'diseño cejas', 'microblading', 'pestañas', 'laminado'],
    'depilación': ['depilación', 'wax', 'cera', 'láser', 'definitiva']
  };
  
  // Encontrar categoría del servicio solicitado
  for (const [categoria, keywords] of Object.entries(reglas)) {
    if (servicioLower.includes(categoria)) {
      // Verificar si el especialista tiene ALGUNA de las keywords
      return keywords.some(kw => expertiseLower.includes(kw));
    }
  }
  
  // Fallback: si no encuentra categoría, verificar expertise directo
  return expertiseLower.includes(servicioLower);
}

function calcularScoreEspecialista(esp, citasOcupadas, horaSolicitada, duracion) {
  let score = 0;
  
  // Factor 1: Carga de trabajo (preferir menos ocupados para balance)
  const citasHoy = citasOcupadas.filter(c => c.especialista === esp.nombre).length;
  if (citasHoy === 0) score += 50;
  else if (citasHoy <= 2) score += 30;
  else if (citasHoy <= 4) score += 10;
  
  // Factor 2: Seniority
  const expLower = (esp.expertise || '').toLowerCase();
  if (expLower.includes('senior') || expLower.includes('experto')) score += 20;
  if (expLower.includes('certificado')) score += 10;
  
  // Factor 3: Disponibilidad exacta (si aplica)
  if (horaSolicitada) {
    const [h, m] = horaSolicitada.split(':').map(Number);
    const minutosSolicitud = h * 60 + m;
    const minutosFin = minutosSolicitud + (duracion || 60);
    
    let conflicto = false;
    for (const cita of citasOcupadas) {
      if (cita.especialista !== esp.nombre) continue;
      
      const [hc, mc] = cita.hora.split(':').map(Number);
      const inicioCita = hc * 60 + mc;
      const finCita = inicioCita + (cita.duracion || 60);
      
      if (minutosSolicitud < finCita && minutosFin > inicioCita) {
        conflicto = true;
        break;
      }
    }
    
    if (!conflicto) score += 100; // Bonus masivo por disponibilidad exacta
  }
  
  return score;
}

// ============ BASE DE DATOS ============

async function cargarDatos() {
  console.log('🔌 Cargando datos de Supabase...');
  
  // Cargar todo en paralelo
  const [especialistasRes, serviciosRes] = await Promise.all([
    supabase.from('especialistas').select('*'),
    supabase.from('servicios').select('*')
  ]);
  
  const especialistas = especialistasRes.data || [];
  const servicios = serviciosRes.data || [];
  
  console.log(`✅ ${especialistas.length} especialistas, ${servicios.length} servicios`);
  
  if (especialistas.length === 0) {
    console.error('❌ CRÍTICO: No hay especialistas en la base de datos');
  }
  
  return { especialistas, servicios };
}

async function obtenerCitasOcupadas(fecha) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` },
      timeout: 10000
    });
    
    return response.data.records.map(r => ({
      hora: r.fields.Hora,
      duracion: r.fields['Duración estimada (minutos)'] || 60,
      especialista: r.fields.Especialista
    }));
  } catch (error) {
    console.error('Error Airtable:', error.message);
    return [];
  }
}

async function guardarRecomendaciones(telefono, recomendaciones) {
  await supabase.from('conversaciones').insert({
    telefono,
    rol: 'system',
    contenido: `RECOMENDACIONES:${JSON.stringify(recomendaciones)}`,
    created_at: new Date().toISOString()
  });
}

async function obtenerRecomendacionesPrevias(telefono) {
  try {
    const { data } = await supabase
      .from('conversaciones')
      .select('contenido')
      .eq('telefono', telefono)
      .eq('rol', 'system')
      .ilike('contenido', 'RECOMENDACIONES:%')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (data?.contenido) {
      return JSON.parse(data.contenido.replace('RECOMENDACIONES:', ''));
    }
    return null;
  } catch (e) {
    return null;
  }
}

function detectarEleccion(mensaje, recomendaciones) {
  if (!recomendaciones?.length) return null;
  
  const msgLower = mensaje.toLowerCase().trim();
  
  // Patrones de posición
  const esPrimero = ['primero', 'primera', '1', 'uno', 'opción 1', 'el primero', 'la primera', 'primer opción'].some(p => msgLower.includes(p));
  const esSegundo = ['segundo', 'segunda', '2', 'dos', 'opción 2', 'el segundo', 'la segunda', 'segunda opción'].some(p => msgLower.includes(p));
  
  if (esPrimero) return recomendaciones[0];
  if (esSegundo && recomendaciones.length > 1) return recomendaciones[1];
  
  // Por nombre
  for (const rec of recomendaciones) {
    const nombreLower = rec.nombre.toLowerCase();
    const primerNombre = nombreLower.split(' ')[0];
    
    if (msgLower.includes(nombreLower) || 
        (primerNombre.length > 3 && msgLower.includes(primerNombre))) {
      return rec;
    }
  }
  
  return null;
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
          "ID_Supabase": datos.supabase_id
        }
      }]
    };
    
    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    return true;
  } catch (error) {
    console.error('Error Airtable:', error.response?.data || error.message);
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
    
    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    
    await axios.patch(url, {
      records: [{
        id: record.id,
        fields: {
          "Fecha": fechaUTC,
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

// ============ GENERACIÓN DE MENSAJES ============

function generarMensajeRecomendacion(recomendaciones, servicio, fecha, hora, cliente) {
  const esNuevo = !cliente?.nombre;
  const saludo = esNuevo ? '¡Hola! 😊' : `¡Hola ${cliente.nombre}! ✨`;
  
  let mensaje = `${saludo}\n\n`;
  mensaje += `Para tu **${servicio.nombre}** el ${formatearFecha(fecha)}`;
  if (hora) mensaje += ` a las ${formatearHora(hora)}`;
  mensaje += `, tengo estas opciones exclusivas:\n\n`;
  
  recomendaciones.forEach((esp, idx) => {
    const label = idx === 0 ? '🌟 Opción recomendada' : '✨ Alternativa ideal';
    mensaje += `${label}:\n`;
    mensaje += `**${esp.nombre}** — ${esp.descripcion}\n`;
    
    if (hora) {
      if (esp.disponibleEnHora) {
        mensaje += `✅ Confirmado para ${formatearHora(hora)}\n`;
      } else if (esp.alternativas?.length > 0) {
        mensaje += `⏰ También disponible: ${esp.alternativas.slice(0, 2).map(h => formatearHora(h)).join(', ')}\n`;
      }
    }
    
    if (esp.citasHoy === 0) {
      mensaje += `💎 Agenda libre — atención VIP\n`;
    }
    
    mensaje += `\n`;
  });
  
  mensaje += `¿Con quién prefieres? Dime el nombre o "primero/segundo" 👇`;
  
  return mensaje;
}

function generarMensajeConfirmacion(cliente, servicio, especialista, fecha, hora) {
  return `¡Perfecto${cliente?.nombre ? ` ${cliente.nombre}` : ''}! 🎉\n\n` +
         `Tu cita está confirmada:\n\n` +
         `📅 ${formatearFecha(fecha)} a las ${formatearHora(hora)}\n` +
         `💅 ${servicio.nombre}\n` +
         `✨ Con ${especialista.nombre}\n` +
         `💰 $${servicio.precio} | ⏱️ ${servicio.duracion} min\n\n` +
         `Te esperamos. ¡Te va a encantar! 😊✨`;
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
    // 1. PROCESAR ENTRADA (VOICE O TEXTO)
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
        console.log('🎤 Voz:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Disculpa, no pude escuchar bien. ¿Me escribes? 🎙️</Message></Response>');
      }
    }

    // 2. CARGAR DATOS CRÍTICOS
    const [{ data: cliente }, { especialistas, servicios }] = await Promise.all([
      supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle(),
      cargarDatos()
    ]);

    // VERIFICACIÓN CRÍTICA: ¿Hay especialistas?
    if (!especialistas || especialistas.length === 0) {
      console.error('❌ FATAL: No se cargaron especialistas');
      return res.status(200).send(`<Response><Message>Estamos teniendo problemas técnicos. Por favor contacta al salón directamente. 🙏</Message></Response>`);
    }

    // 3. CALCULAR FECHAS
    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);
    
    // 4. DETECTAR FECHA DEL MENSAJE
    let fechaCita = fechaHoy;
    const textoLower = textoUsuario.toLowerCase();
    
    if (textoLower.includes('mañana') || textoLower.includes('manana')) {
      fechaCita = fechaManana;
    }
    
    // Buscar fecha explícita (ej: "15 de abril")
    const matchFecha = textoUsuario.match(/(\d{1,2})[^\d]+(\w+)/i);
    if (matchFecha) {
      // Parsear "15 de abril" -> fecha ISO
      // Simplificación: usar mañana si dice mañana, hoy si no
    }

    // 5. DETECTAR HORA
    let horaSolicitada = null;
    const horaMatch = textoUsuario.match(/(\d{1,2}):(\d{2})/) || 
                      textoUsuario.match(/(\d{1,2})\s*(am|pm)/i) ||
                      textoUsuario.match(/a\s+las\s+(\d{1,2})/i);
    
    if (horaMatch) {
      let h = parseInt(horaMatch[1]);
      const m = horaMatch[2] || '00';
      const periodo = (horaMatch[3] || '').toLowerCase();
      
      if (periodo === 'pm' && h < 12) h += 12;
      if (periodo === 'am' && h === 12) h = 0;
      
      horaSolicitada = `${String(h).padStart(2, '0')}:${m}`;
    }

    // 6. CARGAR AGENDA
    const citasOcupadas = await obtenerCitasOcupadas(fechaCita);
    
    // 7. VERIFICAR SI HAY RECOMENDACIONES PREVIAS (PARA DETECTAR ELECCIÓN)
    const recomendacionesPrevias = await obtenerRecomendacionesPrevias(userPhone);
    const eleccionDetectada = detectarEleccion(textoUsuario, recomendacionesPrevias);
    
    console.log('📊 Estado:', {
      cliente: cliente?.nombre || 'NUEVO',
      fecha: fechaCita,
      hora: horaSolicitada,
      eleccion: eleccionDetectada?.nombre || 'Ninguna',
      totalEsp: especialistas.length
    });

    // 8. PREPARAR PROMPT PARA OPENAI
    const contextoEspecialistas = especialistas.map(e => 
      `- ${e.nombre}: ${e.expertise}${e.servicios ? ' | Servicios: ' + e.servicios.join(', ') : ''}`
    ).join('\n');

    const contextoServicios = servicios.map(s => 
      `- ${s.nombre}: $${s.precio}, ${s.duracion}min`
    ).join('\n');

    const systemPrompt = `Eres Aura, la coordinadora de agenda más eficiente de un salón de belleza premium. Eres humana, cálida, directa y profesional.

DATOS REALES DEL SALÓN:
[Especialistas]
${contextoEspecialistas}

[Servicios]
${contextoServicios}

[Agenda del ${formatearFecha(fechaCita)}]
${citasOcupadas.length > 0 ? citasOcupadas.map(c => `- ${c.hora}: ${c.especialista}`).join('\n') : 'Sin citas'}

REGLAS ABSOLUTAS:
1. Si el cliente es nuevo (no tiene nombre), pide amablemente "¿Cómo te llamas?"
2. Detecta el servicio que quiere y sugiere 2 especialistas que SÍ LO HAGAN (verifica expertise)
3. NUNCA sugieras especialistas que no correspondan al servicio
4. Cuando elija especialista, confirma inmediatamente
5. Sé conversacional, usa emojis naturales, máximo 3 por mensaje
6. Precios y tiempos exactos de la lista de servicios

El cliente dijo: "${textoUsuario}"
Fecha detectada: ${fechaCita}
Hora detectada: ${horaSolicitada || 'No especificada'}
${cliente?.nombre ? 'Cliente registrado: ' + cliente.nombre : 'Cliente NUEVO'}`;

    // 9. LLAMAR A OPENAI
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.3,
      max_tokens: 500
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let respuestaAI = aiRes.data.choices[0].message.content;
    
    // 10. EXTRAER JSON SI EXISTE
    const jsonMatch = respuestaAI.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})/);
    let data = {};
    
    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
        respuestaAI = respuestaAI.split('DATA_JSON')[0].trim();
      } catch (e) {
        console.error('Error parsing JSON:', e);
      }
    }

    // 11. LÓGICA DE NEGOCIO (LA CAPA CRÍTICA QUE NO FALLA)

    let mensajeFinal = respuestaAI;
    let accion = data.accion || 'none';

    // A. Si es cliente nuevo y no tenemos nombre, pedirlo
    if (!cliente?.nombre && !data.nombre) {
      mensajeFinal = `¡Hola! 😊 Bienvenido a nuestro salón. Soy Aura, tu coordinadora.\n\nPara agendar tu cita perfecta, ¿cómo te llamas?`;
    }
    
    // B. Si detectamos elección de especialista previa, forzar agendar
    else if (eleccionDetectada && !data.cita_especialista) {
      data.cita_especialista = eleccionDetectada.nombre;
      data.cita_fecha = fechaCita;
      data.cita_hora = horaSolicitada || eleccionDetectada.horarios?.[0];
      accion = 'agendar';
      console.log('✅ Elección forzada:', eleccionDetectada.nombre);
    }

    // C. Si necesitamos recomendar especialistas
    if (accion === 'solicitar_recomendacion' || (data.cita_servicio && !data.cita_especialista && !eleccionDetectada)) {
      
      const servicio = servicios.find(s => 
        s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())
      );

      if (!servicio) {
        mensajeFinal = `No reconocí ese servicio. Tenemos: ${servicios.slice(0, 4).map(s => s.nombre).join(', ')}... ¿Cuál te gustaría?`;
      } else {
        // FILTRAR especialistas válidos
        const validos = especialistas.filter(esp => puedeRealizarServicio(esp, servicio.nombre));
        
        if (validos.length === 0) {
          mensajeFinal = `Lo siento, no tenemos especialistas disponibles para ${servicio.nombre} hoy. ¿Te gustaría otro servicio?`;
        } else if (validos.length === 1) {
          mensajeFinal = `Tengo disponible a **${validos[0].nombre}** para tu ${servicio.nombre}. ¿Te gustaría reservar con ${validos[0].nombre.split(' ')[0]}?`;
        } else {
          // Calcular scores y disponibilidad
          const scored = validos.map(esp => {
            const score = calcularScoreEspecialista(esp, citasOcupadas, horaSolicitada, servicio.duracion);
            const citasHoy = citasOcupadas.filter(c => c.especialista === esp.nombre).length;
            
            // Verificar disponibilidad exacta
            let disponibleEnHora = false;
            let alternativas = [];
            
            if (horaSolicitada) {
              const [h, m] = horaSolicitada.split(':').map(Number);
              const inicio = h * 60 + m;
              const fin = inicio + servicio.duracion;
              
              disponibleEnHora = !citasOcupadas.some(c => {
                if (c.especialista !== esp.nombre) return false;
                const [hc, mc] = c.hora.split(':').map(Number);
                const inicioC = hc * 60 + mc;
                const finC = inicioC + c.duracion;
                return inicio < finC && fin > inicioC;
              });
              
              // Buscar alternativas si no está disponible
              if (!disponibleEnHora) {
                for (let min = 9*60; min <= 18*60 - servicio.duracion; min += 30) {
                  const hAlt = Math.floor(min/60);
                  const mAlt = min%60;
                  const horaAlt = `${String(hAlt).padStart(2,'0')}:${String(mAlt).padStart(2,'0')}`;
                  
                  const conflicto = citasOcupadas.some(c => {
                    if (c.especialista !== esp.nombre) return false;
                    const [hc, mc] = c.hora.split(':').map(Number);
                    const inicioC = hc * 60 + mc;
                    const finC = inicioC + c.duracion;
                    return min < finC && (min + servicio.duracion) > inicioC;
                  });
                  
                  if (!conflicto) alternativas.push(horaAlt);
                }
              }
            }
            
            return {
              ...esp,
              score,
              citasHoy,
              disponibleEnHora,
              alternativas: alternativas.slice(0, 3),
              descripcion: puedeRealizarServicio(esp, servicio.nombre) ? esp.expertise : 'Especialista'
            };
          }).sort((a, b) => b.score - a.score);

          // Tomar top 2
          const top2 = scored.slice(0, 2);
          
          // Guardar para detección futura
          await guardarRecomendaciones(userPhone, top2.map(t => ({
            id: t.id,
            nombre: t.nombre,
            horarios: t.disponibleEnHora ? [horaSolicitada] : t.alternativas
          })));
          
          mensajeFinal = generarMensajeRecomendacion(top2, servicio, fechaCita, horaSolicitada, cliente);
        }
      }
    }

    // D. Agendar cita
    else if (accion === 'agendar' && data.cita_especialista) {
      const servicio = servicios.find(s => 
        s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())
      );
      
      const especialista = especialistas.find(e => 
        e.nombre.toLowerCase().includes(data.cita_especialista.toLowerCase())
      );

      if (!especialista || !servicio) {
        mensajeFinal = `Faltan datos para confirmar. ¿Podemos revisar el servicio y especialista de nuevo?`;
      } else {
        // Verificar que puede hacer el servicio
        if (!puedeRealizarServicio(especialista, servicio.nombre)) {
          mensajeFinal = `Ups, ${especialista.nombre} no realiza ${servicio.nombre}. Déjame recomendarte alguien adecuado...`;
          // Volver a recomendar
          data.accion = 'solicitar_recomendacion';
          data.cita_especialista = null;
        } else {
          // Verificar disponibilidad
          const hora = data.cita_hora || horaSolicitada;
          if (!hora) {
            mensajeFinal = `¿A qué hora te gustaría? Nuestro horario es de 9 AM a 6 PM.`;
          } else {
            // Crear cita
            const fechaHoraISO = `${fechaCita}T${hora}:00-05:00`;
            
            // Insertar en Supabase
            const { data: citaDB } = await supabase.from('citas').insert({
              cliente_id: cliente?.id,
              servicio_id: servicio.id,
              especialista_id: especialista.id,
              fecha_hora: fechaHoraISO,
              estado: 'Confirmada',
              created_at: new Date().toISOString()
            }).select().single();

            // Insertar en Airtable
            await crearCitaAirtable({
              telefono: userPhone,
              nombre: cliente?.nombre || data.nombre || 'Cliente',
              apellido: cliente?.apellido || data.apellido || '',
              fecha: fechaCita,
              hora: hora,
              servicio: servicio.nombre,
              especialista: especialista.nombre,
              precio: servicio.precio,
              duracion: servicio.duracion,
              supabase_id: citaDB?.id
            });

            mensajeFinal = generarMensajeConfirmacion(cliente, servicio, especialista, fechaCita, hora);
            
            // Limpiar recomendaciones
            await guardarRecomendaciones(userPhone, []);
          }
        }
      }
    }

    // E. Cancelar
    else if (accion === 'cancelar') {
      const ok = await cancelarCitaAirtable(userPhone);
      mensajeFinal = ok 
        ? `✅ He cancelado tu cita. ¿Te gustaría agendar algo nuevo?`
        : `No encontré citas activas para cancelar. ¿Necesitas ayuda con otra cosa?`;
    }

    // F. Reagendar
    else if (accion === 'reagendar') {
      const ok = await reagendarCitaAirtable(userPhone, { ...data, cita_fecha: fechaCita });
      mensajeFinal = ok
        ? `✅ Listo, cambié tu cita para ${formatearFecha(fechaCita)} a las ${formatearHora(data.cita_hora)}.`
        : `No encontré tu cita activa. ¿Tienes una reserva confirmada?`;
    }

    // 12. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: mensajeFinal, created_at: new Date().toISOString() }
    ]);

    // 13. RESPONDER
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${mensajeFinal}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error crítico:', err);
    return res.status(200).send('<Response><Message>Disculpa, tuve un problema técnico. ¿Me repites? 🙏</Message></Response>');
  }
}
