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

// ============ NUEVA: Función para recuperar recomendaciones guardadas ============

async function obtenerRecomendacionesGuardadas(userPhone) {
  try {
    const { data } = await supabase
      .from('conversaciones')
      .select('contenido, created_at')
      .eq('telefono', userPhone)
      .eq('rol', 'system')
      .like('contenido', 'RECOMENDACIONES_GUARDADAS:%')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (data?.contenido) {
      const jsonStr = data.contenido.replace('RECOMENDACIONES_GUARDADAS:', '');
      return JSON.parse(jsonStr);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============ NUEVA: Función para detectar si el usuario está eligiendo un especialista ============

function detectarEleccionEspecialista(textoUsuario, recomendacionesPrevias) {
  if (!recomendacionesPrevias || recomendacionesPrevias.length === 0) return null;
  
  const textoLower = textoUsuario.toLowerCase().trim();
  
  // Patrones de elección
  const patronesPrimero = ['primero', 'primera', '1', 'uno', 'primera opción', 'opción 1', 'el primero', 'la primera'];
  const patronesSegundo = ['segundo', 'segunda', '2', 'dos', 'segunda opción', 'opción 2', 'el segundo', 'la segunda'];
  
  // Detectar por número/posición
  if (patronesPrimero.some(p => textoLower.includes(p))) {
    return recomendacionesPrevias[0];
  }
  if (patronesSegundo.some(p => textoLower.includes(p)) && recomendacionesPrevias.length > 1) {
    return recomendacionesPrevias[1];
  }
  
  // Detectar por nombre
  for (const rec of recomendacionesPrevias) {
    const nombreLower = rec.nombre.toLowerCase();
    const nombreParts = nombreLower.split(' ');
    
    // Coincidencia exacta o parcial del nombre
    if (textoLower.includes(nombreLower) || 
        nombreParts.some(part => textoLower.includes(part) && part.length > 3)) {
      return rec;
    }
  }
  
  return null;
}

// ============ NUEVA: Función para verificar disponibilidad de especialista ============

async function verificarDisponibilidadEspecialista(fecha, hora, duracionMinutos, especialistaNombre, citasOcupadas) {
  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracionMinutos || 60);

  for (const cita of citasOcupadas) {
    if (cita.especialista === especialistaNombre) {
      const [he, me] = cita.hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + cita.duracion;

      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        return { disponible: false, conflicto: cita };
      }
    }
  }

  return { disponible: true };
}

// ============ NUEVA: Función para obtener slots disponibles por especialista ============

async function obtenerSlotsDisponibles(fecha, duracionMinutos, citasOcupadas, especialistas) {
  const horaApertura = 9 * 60;
  const horaCierre = 18 * 60;
  const slots = [];
  
  for (let minutos = horaApertura; minutos <= horaCierre - duracionMinutos; minutos += 30) {
    const hora = `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
    const finSlot = minutos + duracionMinutos;
    
    const especialistasDisponibles = [];
    
    for (const esp of especialistas) {
      let disponible = true;
      
      for (const cita of citasOcupadas) {
        if (cita.especialista === esp.nombre) {
          const [he, me] = cita.hora.split(':').map(Number);
          const inicioExistente = he * 60 + me;
          const finExistente = inicioExistente + cita.duracion;
          
          if (minutos < finExistente && finSlot > inicioExistente) {
            disponible = false;
            break;
          }
        }
      }
      
      if (disponible) especialistasDisponibles.push(esp);
    }
    
    if (especialistasDisponibles.length > 0) {
      slots.push({ hora, especialistas: especialistasDisponibles, cantidad: especialistasDisponibles.length });
    }
  }
  
  return slots;
}

// ============ MEJORADA: Función para recomendar especialistas inteligentemente ============

async function recomendarEspecialistasInteligente(especialistas, servicioSolicitado, fecha, horaPreferida, duracionMinutos, citasOcupadas, servicios) {
  
  const servicio = servicios?.find(s => 
    s.nombre.toLowerCase().includes((servicioSolicitado || '').toLowerCase())
  );

  const especialistasScored = await Promise.all(especialistas.map(async (esp) => {
    let score = 0;
    let motivo = "";
    let estaDisponible = true;
    let alternativasHorario = [];

    if (horaPreferida) {
      const disponibilidad = await verificarDisponibilidadEspecialista(
        fecha, horaPreferida, duracionMinutos, esp.nombre, citasOcupadas
      );
      estaDisponible = disponibilidad.disponible;
    }

    const citasDelDia = citasOcupadas.filter(c => c.especialista === esp.nombre).length;
    score += (3 - Math.min(citasDelDia, 3)) * 10;

    const expertiseLower = (esp.expertise || '').toLowerCase();
    const servicioLower = (servicioSolicitado || '').toLowerCase();
    
    if (servicioLower.includes('corte') || servicioLower.includes('cabello')) {
      if (expertiseLower.includes('corte') && expertiseLower.includes('estructural')) {
        score += 40;
        motivo = "Especialista en cortes estructurales y formas";
      } else if (expertiseLower.includes('color')) {
        score += 35;
        motivo = "Experto en colorimetría y tendencias";
      } else if (expertiseLower.includes('corte')) {
        score += 30;
        motivo = "Especialista en cortes";
      }
    } 
    else if (servicioLower.includes('color') || servicioLower.includes('tinte')) {
      if (expertiseLower.includes('color') && expertiseLower.includes('avanzada')) {
        score += 40;
        motivo = "Colorista experto en técnicas avanzadas";
      } else if (expertiseLower.includes('color')) {
        score += 35;
        motivo = "Especialista en colorimetría";
      }
    }
    else if (servicioLower.includes('manicura') || servicioLower.includes('pedicura') || servicioLower.includes('uña')) {
      if (expertiseLower.includes('spa') || expertiseLower.includes('tratamiento')) {
        score += 40;
        motivo = "Especialista en tratamientos de spa para manos/pies";
      } else if (expertiseLower.includes('manicura') || expertiseLower.includes('pedicura')) {
        score += 35;
        motivo = "Experto en cuidado de uñas";
      } else if (expertiseLower.includes('art') || expertiseLower.includes('diseño')) {
        score += 40;
        motivo = "Artista en nail art y diseños personalizados";
      }
    }
    else if (servicioLower.includes('facial') || servicioLower.includes('tratamiento')) {
      if (expertiseLower.includes('facial') && expertiseLower.includes('avanzado')) {
        score += 40;
        motivo = "Especialista en tratamientos faciales avanzados";
      } else if (expertiseLower.includes('facial')) {
        score += 35;
        motivo = "Experto en cuidado facial";
      }
    }
    else if (servicioLower.includes('maquillaje')) {
      if (expertiseLower.includes('social')) {
        score += 40;
        motivo = "Maquillista profesional para eventos sociales";
      } else if (expertiseLower.includes('novia')) {
        score += 40;
        motivo = "Especialista en maquillaje de novia";
      }
    }
    else {
      if (expertiseLower.includes('senior') || expertiseLower.includes('experto')) {
        score += 30;
        motivo = "Profesional senior con amplia experiencia";
      } else {
        score += 20;
        motivo = "Especialista certificado";
      }
    }

    if (!estaDisponible && horaPreferida) {
      const slots = await obtenerSlotsDisponibles(fecha, duracionMinutos, citasOcupadas, [esp]);
      const [hPref, mPref] = horaPreferida.split(':').map(Number);
      const minutosPref = hPref * 60 + mPref;
      
      alternativasHorario = slots
        .map(s => {
          const [h, m] = s.hora.split(':').map(Number);
          return { hora: s.hora, diferencia: Math.abs((h * 60 + m) - minutosPref) };
        })
        .sort((a, b) => a.diferencia - b.diferencia)
        .slice(0, 3)
        .map(s => s.hora);
    }

    return {
      ...esp,
      score,
      motivo,
      estaDisponible,
      horarioSugerido: horaPreferida,
      alternativasHorario,
      citasDelDia,
      precioServicio: servicio?.precio || 0
    };
  }));

  const disponibles = especialistasScored.filter(e => e.estaDisponible).sort((a, b) => b.score - a.score);
  const noDisponibles = especialistasScored.filter(e => !e.estaDisponible).sort((a, b) => b.score - a.score);

  let seleccionados = disponibles.slice(0, 2);
  
  if (seleccionados.length < 2) {
    const complemento = noDisponibles
      .filter(e => e.alternativasHorario.length > 0)
      .slice(0, 2 - seleccionados.length);
    seleccionados = [...seleccionados, ...complemento];
  }

  if (seleccionados.length < 2) {
    const restantes = especialistasScored
      .filter(e => !seleccionados.find(s => s.id === e.id))
      .slice(0, 2 - seleccionados.length);
    seleccionados = [...seleccionados, ...restantes];
  }

  return seleccionados;
}

// ============ MEJORADA: Generar mensaje persuasivo ============

function generarMensajeRecomendacion(recomendaciones, servicioSolicitado, fecha, horaPreferida) {
  if (!recomendaciones || recomendaciones.length === 0) {
    return "Te recomiendo a **nuestro equipo de especialistas**, todos certificados con estándares internacionales.";
  }

  let mensaje = `¡Perfecto! Para tu **${servicioSolicitado}** el ${formatearFecha(fecha)}`;
  if (horaPreferida) mensaje += ` alrededor de las ${horaPreferida}`;
  mensaje += `, tengo estas opciones exclusivas para ti:\n\n`;

  recomendaciones.forEach((esp, index) => {
    const opcion = index === 0 ? "🥇 Opción Premium" : "🥈 Alternativa Perfecta";
    
    mensaje += `${opcion}:\n`;
    mensaje += `*${esp.nombre}* — ${esp.motivo}\n`;
    
    if (esp.estaDisponible && horaPreferida) {
      mensaje += `✅ Disponible a las ${horaPreferida}\n`;
    } else if (esp.alternativasHorario.length > 0) {
      mensaje += `⏰ Disponible a las: ${esp.alternativasHorario.join(', ')}\n`;
    } else {
      mensaje += `⚠️ Consultar disponibilidad específica\n`;
    }
    
    if (esp.citasDelDia === 0) {
      mensaje += `🟢 Agenda libre - atención exclusiva garantizada\n`;
    } else if (esp.citasDelDia < 3) {
      mensaje += `🟡 Poca carga - atención personalizada\n`;
    }
    
    mensaje += `\n`;
  });

  mensaje += `¿Con cuál especialista te gustaría reservar? (Responde con el nombre o "el primero/segundo")`;

  return mensaje;
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
    
    console.log('📤 Airtable:', fechaUTC, datos.hora);
    
    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
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

    // 3. FECHAS BASE
    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);

    // 4. CARGAR HISTORIAL
    const { data: historialCompleto } = await supabase
      .from('conversaciones')
      .select('rol, contenido, created_at')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(15);

    // 5. DETECTAR INTENCIÓN DE FECHA Y HORA
    let intencionFechaDetectada = null;
    let fechaExplicitaEncontrada = null;
    let horaDetectada = null;
    
    // Buscar hora en mensaje actual
    const horaMatch = textoUsuario.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i) || 
                      textoUsuario.match(/(\d{1,2})\s*(am|pm)/i) ||
                      textoUsuario.match(/a\s+las\s+(\d{1,2})/i);
    
    if (horaMatch) {
      let horas = parseInt(horaMatch[1]);
      const minutos = horaMatch[2] || '00';
      const periodo = (horaMatch[3] || '').toLowerCase();
      
      if (periodo === 'pm' && horas < 12) horas += 12;
      if (periodo === 'am' && horas === 12) horas = 0;
      
      horaDetectada = `${String(horas).padStart(2, '0')}:${minutos}`;
    }

    // Buscar en historial
    for (const msg of historialCompleto || []) {
      if (msg.rol === 'user') {
        const contenidoLower = msg.contenido.toLowerCase();
        
        if (contenidoLower.includes('mañana') || contenidoLower.includes('manana')) {
          intencionFechaDetectada = 'manana';
        } else if (contenidoLower.includes('hoy')) {
          intencionFechaDetectada = 'hoy';
        }
        
        const matchFechaISO = msg.contenido.match(/(\d{4}-\d{2}-\d{2})/);
        if (matchFechaISO) fechaExplicitaEncontrada = matchFechaISO[1];
      }
    }
    
    const textoLower = textoUsuario.toLowerCase();
    if (textoLower.includes('mañana') || textoLower.includes('manana')) {
      intencionFechaDetectada = 'manana';
    } else if (textoLower.includes('hoy')) {
      intencionFechaDetectada = 'hoy';
    }

    // 6. DETERMINAR FECHA FINAL
    let fechaFinal;
    let fuenteFecha;
    
    if (fechaExplicitaEncontrada && fechaExplicitaEncontrada >= fechaHoy) {
      fechaFinal = fechaExplicitaEncontrada;
      fuenteFecha = 'fecha_explicita_historial';
    } else if (intencionFechaDetectada === 'manana') {
      fechaFinal = fechaManana;
      fuenteFecha = 'intencion_manana';
    } else if (intencionFechaDetectada === 'hoy') {
      fechaFinal = fechaHoy;
      fuenteFecha = 'intencion_hoy';
    } else {
      let fechaPrevioMensaje = null;
      for (const msg of historialCompleto || []) {
        if (msg.rol === 'assistant') {
          const matchFechaFormateada = msg.contenido.match(/(\d{4}-\d{2}-\d{2})/);
          if (matchFechaFormateada) {
            fechaPrevioMensaje = matchFechaFormateada[1];
            break;
          }
        }
      }
      
      if (fechaPrevioMensaje && fechaPrevioMensaje >= fechaHoy) {
        fechaFinal = fechaPrevioMensaje;
        fuenteFecha = 'contexto_previo';
      } else {
        fechaFinal = fechaHoy;
        fuenteFecha = 'default_hoy';
      }
    }

    // 7. BUSCAR RECOMENDACIONES PREVIAS Y DETECTAR ELECCIÓN
    const recomendacionesPrevias = await obtenerRecomendacionesGuardadas(userPhone);
    const eleccionDetectada = detectarEleccionEspecialista(textoUsuario, recomendacionesPrevias);
    
    console.log('🔍 ANÁLISIS:', {
      fechaFinal,
      horaDetectada,
      tieneRecomendaciones: !!recomendacionesPrevias,
      eleccionDetectada: eleccionDetectada?.nombre || null,
      mensaje: textoUsuario.substring(0, 50)
    });

    // 8. CONSULTAR AGENDA
    const citasOcupadas = await obtenerCitasOcupadas(fechaFinal);
    const historialFormateado = historialCompleto?.slice(0, 6).reverse().map(h => 
      `${h.rol === 'user' ? 'Cliente' : 'Aura'}: ${h.contenido}`
    ).join('\n') || '';

    // 9. SYSTEM PROMPT ADAPTATIVO
    let systemPrompt = `Eres Aura, coordinadora de lujo de AuraSync.

[FECHA BLOQUEADA]
Fecha definitiva: ${formatearFecha(fechaFinal)} (${fechaFinal})
Fuente: ${fuenteFecha}

[DATOS]
- Hoy: ${formatearFecha(fechaHoy)}
- Mañana: ${formatearFecha(fechaManana)}
- Fecha cita: ${formatearFecha(fechaFinal)}
- Hora cliente: ${horaDetectada || 'No detectada'}
- Citas ocupadas: ${citasOcupadas.map(c => `${c.hora} ${c.especialista}`).join(', ')}

[ESPECIALISTAS]
${especialistas?.map(e => `- ${e.nombre}: ${e.expertise}`).join('\n')}

[SERVICIOS]
${servicios?.map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion}min`).join('\n')}

[HISTORIAL]
${historialFormateado}`;

    // Si hay elección detectada, forzar acción de agendar
    if (eleccionDetectada) {
      systemPrompt += `\n\n[RECOMENDACIÓN PREVIA DETECTADA]
El usuario está respondiendo a una recomendación previa. Ha elegido a: ${eleccionDetectada.nombre}
Horarios posibles: ${eleccionDetectada.horarios?.join(', ') || horaDetectada || 'consultar'}

[INSTRUCCIÓN CRÍTICA]
El usuario YA eligió un especialista. NO recomiendes de nuevo.
Si hay horario disponible, confirma la cita inmediatamente.
Si no hay horario, pregunta por alternativas.

JSON DEBE SER:
DATA_JSON:{
  "accion": "agendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "${fechaFinal}",
  "cita_hora": "${horaDetectada || eleccionDetectada.horarios?.[0] || ''}",
  "cita_servicio": "servicio detectado en contexto",
  "cita_especialista": "${eleccionDetectada.nombre}",
  "eleccion_previa": true
}`;
    } else {
      systemPrompt += `\n\n[REGLAS]
1. La cita SIEMPRE será para el ${formatearFecha(fechaFinal)}.
2. Si el cliente menciona servicio+hora, indica que revisarás disponibilidad.
3. NUNCA asignes especialista directamente sin recomendar primero.

JSON:
DATA_JSON:{
  "accion": "none" | "solicitar_recomendacion" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "${fechaFinal}",
  "cita_hora": "${horaDetectada || ''}",
  "cita_servicio": "servicio detectado",
  "cita_especialista": "",
  "necesita_recomendacion": true | false,
  "hora_propuesta": "${horaDetectada || ''}"
}`;
    }

    // 10. LLAMADA A OPENAI
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: eleccionDetectada ? 0.0 : 0.1, // Más determinista si hay elección
      max_tokens: 500
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let reply = aiRes.data.choices[0].message.content;
    console.log('📝 Respuesta OpenAI:', reply.substring(0, 300));

    // 11. PROCESAR RESPUESTA
    const jsonMatch = reply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})/);
    let data = {};
    let accionEjecutada = false;
    let mensajeFinal = reply.split('DATA_JSON')[0].trim();

    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
        
        // Corregir fecha
        if (data.cita_fecha !== fechaFinal) {
          data.cita_fecha = fechaFinal;
        }
        
        // SOBREESCRIBIR con elección detectada si existe
        if (eleccionDetectada && !data.cita_especialista) {
          data.cita_especialista = eleccionDetectada.nombre;
          data.accion = 'agendar';
          if (!data.cita_hora && eleccionDetectada.horarios) {
            data.cita_hora = eleccionDetectada.horarios[0];
          }
        }
        
        // Registrar cliente
        if (data.nombre && !cliente?.nombre) {
          const { data: nuevoCliente } = await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: data.nombre,
            apellido: data.apellido || "",
            created_at: new Date().toISOString()
          }, { onConflict: 'telefono' }).select().single();
          
          cliente = nuevoCliente;
        }

        const servicio = servicios?.find(s => 
          s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())
        );

        // ============ RECOMENDACIÓN INTELIGENTE ============
        if (data.necesita_recomendacion || data.accion === 'solicitar_recomendacion' || 
            (data.cita_servicio && !data.cita_especialista && !eleccionDetectada)) {
          
          if (servicio && especialistas?.length > 0) {
            const recomendaciones = await recomendarEspecialistasInteligente(
              especialistas,
              data.cita_servicio,
              fechaFinal,
              data.hora_propuesta || data.cita_hora,
              servicio.duracion,
              citasOcupadas,
              servicios
            );
            
            // Guardar recomendaciones
            const recomendacionesJSON = JSON.stringify(recomendaciones.map(r => ({
              id: r.id,
              nombre: r.nombre,
              horarios: r.estaDisponible ? [data.hora_propuesta || data.cita_hora] : r.alternativasHorario
            })));
            
            await supabase.from('conversaciones').insert({
              telefono: userPhone,
              rol: 'system',
              contenido: `RECOMENDACIONES_GUARDADAS:${recomendacionesJSON}`,
              created_at: new Date().toISOString()
            });

            mensajeFinal = generarMensajeRecomendacion(
              recomendaciones, 
              data.cita_servicio, 
              fechaFinal, 
              data.hora_propuesta || data.cita_hora
            );
            
          } else if (!servicio && data.cita_servicio) {
            mensajeFinal = `No reconocí "${data.cita_servicio}". ¿Es: ${servicios?.slice(0, 3).map(s => s.nombre).join(', ')}...?`;
          } else {
            mensajeFinal = `¿Qué servicio te gustaría? Tenemos: ${servicios?.map(s => s.nombre).join(', ')}.`;
          }
          
          accionEjecutada = false;
        }

        // ============ AGENDAR ============
        else if (data.accion === 'agendar' && data.cita_hora && data.cita_especialista) {
          
          const especialista = especialistas?.find(e => 
            e.nombre.toLowerCase().includes((data.cita_especialista || '').toLowerCase())
          );

          if (!especialista) {
            mensajeFinal = `No encontré a ${data.cita_especialista}. ¿Podrías elegir entre las opciones que te di?`;
          } else if (!servicio) {
            mensajeFinal = `¿Qué servicio es? Tenemos: ${servicios?.map(s => s.nombre).join(', ')}.`;
          } else {
            // Verificar disponibilidad
            const disponible = await verificarDisponibilidad(
              fechaFinal,
              data.cita_hora,
              data.cita_especialista,
              servicio.duracion,
              citasOcupadas
            );

            if (!disponible.ok) {
              // Ofrecer alternativas
              const slots = await obtenerSlotsDisponibles(
                fechaFinal, 
                servicio.duracion, 
                citasOcupadas, 
                [especialista]
              );
              
              if (slots.length > 0) {
                const alternativas = slots.slice(0, 3).map(s => s.hora).join(', ');
                mensajeFinal = `${data.cita_especialista} no está disponible a las ${data.cita_hora}. ¿Te funciona: ${alternativas}?`;
              } else {
                mensajeFinal = disponible.mensaje;
              }
            } else {
              // CREAR CITA
              const fechaHoraISO = `${fechaFinal}T${data.cita_hora}:00-05:00`;
              
              console.log('🕐 AGENDANDO:', {
                fechaFinal,
                hora: data.cita_hora,
                servicio: servicio.nombre,
                especialista: especialista.nombre
              });

              const { data: citaSupabase, error: errorSupabase } = await supabase
                .from('citas')
                .insert({
                  cliente_id: cliente?.id,
                  servicio_id: servicio.id,
                  especialista_id: especialista.id,
                  fecha_hora: fechaHoraISO,
                  estado: 'Confirmada',
                  created_at: new Date().toISOString()
                })
                .select()
                .single();

              if (errorSupabase) throw errorSupabase;

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

              mensajeFinal = `✅ ¡Excelente elección, ${cliente?.nombre || data.nombre || ''}! Tu cita está confirmada:\n\n📅 ${formatearFecha(fechaFinal)} a las ${data.cita_hora}\n💇‍♀️ ${servicio.nombre}\n👤 Con ${especialista.nombre}\n💰 $${servicio.precio} | ⏱️ ${servicio.duracion} min\n\nTe esperamos. ✨`;
              accionEjecutada = true;
              
              // Limpiar recomendaciones guardadas después de agendar
              await supabase.from('conversaciones').insert({
                telefono: userPhone,
                rol: 'system',
                contenido: 'RECOMENDACIONES_GUARDADAS:[]',
                created_at: new Date().toISOString()
              });
            }
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

    // 12. GUARDAR Y RESPONDER
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: mensajeFinal, created_at: new Date().toISOString() }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${mensajeFinal}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error crítico:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento. ¿Me repites? 🌸</Message></Response>');
  }
}
