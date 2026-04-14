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

function formatearHora(hora24) {
  if (!hora24) return '';
  const [h, m] = hora24.split(':').map(Number);
  const periodo = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

// ============ NUEVA: Matching estricto especialista-servicio ============

function especialistaPuedeHacerServicio(especialista, servicioNombre) {
  if (!especialista.servicios && !especialista.expertise) return false;
  
  const servicioLower = (servicioNombre || '').toLowerCase();
  const expertiseLower = (especialista.expertise || '').toLowerCase();
  
  // Mapeo de servicios a expertise válido
  const mapaServicios = {
    'pedicura': ['pedicura', 'spa pies', 'manicura y pedicura', 'uñas', 'podología', 'esteticista'],
    'manicura': ['manicura', 'nail art', 'uñas', 'manicura y pedicura', 'esteticista'],
    'corte': ['corte', 'barbero', 'estilista', 'color', 'degradado'],
    'tinte': ['color', 'tinte', 'mechas', 'balayage', 'estilista'],
    'facial': ['facial', 'tratamiento facial', 'esteticista', 'dermo'],
    'maquillaje': ['maquillaje', 'makeup', 'social', 'novia'],
    'masaje': ['masaje', 'spa', 'terapeuta', 'relajación'],
    'depilación': ['depilación', 'wax', 'láser', 'esteticista']
  };
  
  // Encontrar categoría del servicio
  let categoriaMatch = null;
  for (const [categoria, keywords] of Object.entries(mapaServicios)) {
    if (keywords.some(k => servicioLower.includes(k)) || servicioLower.includes(categoria)) {
      categoriaMatch = categoria;
      break;
    }
  }
  
  if (!categoriaMatch) return true; // Si no reconoce, permitir (fallback)
  
  // Verificar si el especialista tiene expertise en esta categoría
  const expertiseValido = mapaServicios[categoriaMatch];
  const puede = expertiseValido.some(exp => expertiseLower.includes(exp));
  
  // También verificar campo servicios si existe (array de IDs o nombres)
  if (especialista.servicios && Array.isArray(especialista.servicios)) {
    const serviciosLower = especialista.servicios.map(s => s.toLowerCase());
    if (serviciosLower.some(s => servicioLower.includes(s) || s.includes(servicioLower))) {
      return true;
    }
  }
  
  return puede;
}

// ============ NUEVA: Optimización de agenda ============

function calcularScoreOptimizacion(especialista, citasOcupadas, fecha, duracionServicio) {
  let score = 0;
  
  // 1. Carga actual del día (preferir menos citas para balancear)
  const citasHoy = citasOcupadas.filter(c => c.especialista === especialista.nombre).length;
  score += (5 - citasHoy) * 15; // Max 75 puntos por agenda vacía
  
  // 2. Huecos en agenda (preferir especialistas con huecos que se llenen bien)
  const horasOcupadas = citasOcupadas
    .filter(c => c.especialista === especialista.nombre)
    .map(c => {
      const [h, m] = c.hora.split(':').map(Number);
      return h * 60 + m;
    })
    .sort((a, b) => a - b);
  
  // Calcular huecos entre citas
  for (let i = 0; i < horasOcupadas.length - 1; i++) {
    const hueco = horasOcupadas[i+1] - (horasOcupadas[i] + 60); // asumiendo 60min por cita
    if (hueco >= duracionServicio && hueco <= duracionServicio + 30) {
      score += 50; // Hueco perfecto para este servicio
    }
  }
  
  // 3. Preferir especialistas con agenda casi llena (maximizar ingresos)
  if (citasHoy >= 4) score += 20; // Bonus por productividad
  
  // 4. Seniority (si tiene nivel en los datos)
  if (especialista.nivel === 'senior' || especialista.expertise?.toLowerCase().includes('senior')) {
    score += 10;
  }
  
  return score;
}

// ============ NUEVA: Recuperar recomendaciones ============

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

// ============ NUEVA: Detectar elección ============

function detectarEleccionEspecialista(textoUsuario, recomendacionesPrevias) {
  if (!recomendacionesPrevias || recomendacionesPrevias.length === 0) return null;
  
  const textoLower = textoUsuario.toLowerCase().trim();
  
  // Por posición
  const patronesPrimero = ['primero', 'primera', '1', 'uno', 'opción 1', 'el primero', 'la primera', 'primer'];
  const patronesSegundo = ['segundo', 'segunda', '2', 'dos', 'opción 2', 'el segundo', 'la segunda'];
  
  if (patronesPrimero.some(p => textoLower.includes(p))) return recomendacionesPrevias[0];
  if (patronesSegundo.some(p => textoLower.includes(p)) && recomendacionesPrevias.length > 1) {
    return recomendacionesPrevias[1];
  }
  
  // Por nombre
  for (const rec of recomendacionesPrevias) {
    const nombreLower = rec.nombre.toLowerCase();
    const nombreParts = nombreLower.split(' ');
    
    if (textoLower.includes(nombreLower) || 
        nombreParts.some(part => textoLower.includes(part) && part.length > 3)) {
      return rec;
    }
  }
  
  return null;
}

// ============ NUEVA: Verificar disponibilidad ============

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

// ============ MEJORADA: Recomendación inteligente con filtro estricto ============

async function recomendarEspecialistasOptimizado(especialistas, servicioSolicitado, fecha, horaPreferida, duracionMinutos, citasOcupadas, servicios) {
  
  // 1. FILTRAR solo especialistas que PUEDEN hacer este servicio
  const especialistasValidos = especialistas.filter(esp => 
    especialistaPuedeHacerServicio(esp, servicioSolicitado)
  );
  
  console.log('🎯 Matching servicio-especialista:', {
    servicio: servicioSolicitado,
    totalEspecialistas: especialistas.length,
    validos: especialistasValidos.length,
    nombres: especialistasValidos.map(e => e.nombre)
  });
  
  if (especialistasValidos.length === 0) {
    return { error: 'no_especialistas', mensaje: `Lo siento, no tenemos especialistas disponibles para ${servicioSolicitado} en este momento.` };
  }
  
  if (especialistasValidos.length === 1) {
    return { error: 'solo_uno', especialista: especialistasValidos[0] };
  }

  // 2. Calcular scores de optimización
  const especialistasScored = await Promise.all(especialistasValidos.map(async (esp) => {
    let estaDisponible = true;
    let alternativasHorario = [];
    
    // Verificar disponibilidad en hora preferida
    if (horaPreferida) {
      const check = await verificarDisponibilidadEspecialista(
        fecha, horaPreferida, duracionMinutos, esp.nombre, citasOcupadas
      );
      estaDisponible = check.disponible;
    }
    
    // Calcular score de optimización
    const scoreOptimizacion = calcularScoreOptimizacion(esp, citasOcupadas, fecha, duracionMinutos);
    
    // Buscar alternativas si no está disponible
    if (!estaDisponible && horaPreferida) {
      const slots = await obtenerSlotsAlternativos(fecha, duracionMinutos, citasOcupadas, esp);
      alternativasHorario = slots.slice(0, 3);
    }
    
    // Generar descripción persuasiva basada en expertise real
    const descripcion = generarDescripcionEspecialista(esp, servicioSolicitado);
    
    return {
      ...esp,
      scoreOptimizacion,
      estaDisponible,
      horarioPreferido: horaPreferida,
      alternativasHorario,
      descripcion,
      citasDelDia: citasOcupadas.filter(c => c.especialista === esp.nombre).length
    };
  }));

  // 3. Ordenar: disponibles primero, luego por score
  const disponibles = especialistasScored
    .filter(e => e.estaDisponible)
    .sort((a, b) => b.scoreOptimizacion - a.scoreOptimizacion);
    
  const noDisponibles = especialistasScored
    .filter(e => !e.estaDisponible && e.alternativasHorario.length > 0)
    .sort((a, b) => b.scoreOptimizacion - a.scoreOptimizacion);

  // 4. Seleccionar top 2 (mínimo 2 como pides)
  let seleccionados = disponibles.slice(0, 2);
  
  if (seleccionados.length < 2) {
    const complemento = noDisponibles.slice(0, 2 - seleccionados.length);
    seleccionados = [...seleccionados, ...complemento];
  }
  
  // Si aún no hay 2, agregar cualquiera (no debería pasar por el filtro inicial)
  if (seleccionados.length < 2 && especialistasValidos.length >= 2) {
    const restantes = especialistasValidos
      .filter(e => !seleccionados.find(s => s.id === e.id))
      .slice(0, 2 - seleccionados.length);
    seleccionados = [...seleccionados, ...restantes];
  }

  return { recomendaciones: seleccionados };
}

function generarDescripcionEspecialista(esp, servicioSolicitado) {
  const servicioLower = (servicioSolicitado || '').toLowerCase();
  const expertise = esp.expertise || '';
  
  // Descripciones específicas por servicio
  if (servicioLower.includes('pedicura')) {
    if (expertise.toLowerCase().includes('spa')) return "Especialista en pedicura spa con técnicas de relajación";
    if (expertise.toLowerCase().includes('podología')) return "Experto en cuidado podológico y pedicura terapéutica";
    return "Especialista certificado en pedicura y cuidado de pies";
  }
  
  if (servicioLower.includes('manicura')) {
    if (expertise.toLowerCase().includes('art')) return "Artista en nail art y diseños personalizados";
    if (expertise.toLowerCase().includes('gel')) return "Experto en manicura gel y acrílico";
    return "Especialista en manicura y cuidado de manos";
  }
  
  if (servicioLower.includes('corte') || servicioLower.includes('cabello')) {
    if (expertise.toLowerCase().includes('barbero')) return "Barbero experto en cortes clásicos y modernos";
    if (expertise.toLowerCase().includes('color')) return "Estilista experto en colorimetría y cortes";
    return "Estilista profesional con ojo para las tendencias";
  }
  
  return expertise || "Especialista certificado";
}

async function obtenerSlotsAlternativos(fecha, duracionMinutos, citasOcupadas, especialista) {
  const horaApertura = 9 * 60;
  const horaCierre = 18 * 60;
  const slots = [];
  
  for (let minutos = horaApertura; minutos <= horaCierre - duracionMinutos; minutos += 30) {
    const hora = `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
    const finSlot = minutos + duracionMinutos;
    
    let disponible = true;
    for (const cita of citasOcupadas) {
      if (cita.especialista === especialista.nombre) {
        const [he, me] = cita.hora.split(':').map(Number);
        const inicioExistente = he * 60 + me;
        const finExistente = inicioExistente + cita.duracion;
        
        if (minutos < finExistente && finSlot > inicioExistente) {
          disponible = false;
          break;
        }
      }
    }
    
    if (disponible) slots.push(hora);
  }
  
  return slots;
}

// ============ MEJORADA: Mensaje persuasivo humano ============

function generarMensajeRecomendacionHumano(resultado, servicioSolicitado, fecha, horaPreferida, cliente, servicio) {
  
  // Caso error
  if (resultado.error === 'no_especialistas') {
    return `¡Hola${cliente?.nombre ? ` ${cliente.nombre}` : ''}! 😊\n\n${resultado.mensaje}\n\n¿Te gustaría que te sugiera otro servicio similar o una fecha diferente?`;
  }
  
  // Caso solo un especialista
  if (resultado.error === 'solo_uno') {
    const esp = resultado.especialista;
    return `¡Hola${cliente?.nombre ? ` ${cliente.nombre}` : ''}! ✨\n\nPara tu **${servicioSolicitado}** el ${formatearFecha(fecha)}${horaPreferida ? ` a las ${formatearHora(horaPreferida)}` : ''}, tengo disponible a:\n\n👤 **${esp.nombre}** — ${esp.expertise || 'Especialista certificado'}\n${esp.estaDisponible ? `✅ Confirmado para ${formatearHora(horaPreferida)}` : '⏰ Consultar horarios disponibles'}\n\n¿Te gustaría reservar con ${esp.nombre.split(' ')[0]}?`;
  }
  
  // Caso normal (2+ recomendaciones)
  const recs = resultado.recomendaciones;
  let mensaje = `¡Hola${cliente?.nombre ? ` ${cliente.nombre}` : ''}! ✨\n\nPerfecto, para tu **${servicioSolicitado}** el ${formatearFecha(fecha)}${horaPreferida ? ` a las ${formatearHora(horaPreferida)}` : ''}, revisé nuestra agenda y tengo ${recs.length} opciones ideales para ti:\n\n`;
  
  recs.forEach((esp, index) => {
    const esPremium = index === 0;
    const badge = esPremium ? '🌟' : '✨';
    const label = esPremium ? 'Opción recomendada' : 'Alternativa ideal';
    
    mensaje += `${badge} *${label}:*\n`;
    mensaje += `**${esp.nombre}** — ${esp.descripcion}\n`;
    
    if (esp.estaDisponible && horaPreferida) {
      mensaje += `✅ Libre a las ${formatearHora(horaPreferida)}\n`;
    } else if (esp.alternativasHorario.length > 0) {
      mensaje += `⏰ También disponible: ${esp.alternativasHorario.slice(0, 2).map(h => formatearHora(h)).join(', ')}\n`;
    }
    
    // Contexto de agenda para transmitir exclusividad
    if (esp.citasDelDia === 0) {
      mensaje += `💎 Agenda completamente libre — atención VIP garantizada\n`;
    } else if (esp.citasDelDia < 3) {
      mensaje += `🟡 Solo ${esp.citasDelDia} citas antes que tú — atención preferencial\n`;
    }
    
    mensaje += `\n`;
  });
  
  if (servicio) {
    mensaje += `💰 Servicio: $${servicio.precio} | ⏱️ Duración: ${servicio.duracion} min\n\n`;
  }
  
  mensaje += `¿Con quién prefieres reservar? Solo dime el nombre o "el primero/segundo" 😊`;

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
    console.error('Error Airtable:', error.message);
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
    // 1. PROCESAR ENTRADA
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
      } catch (error) {
        return res.status(200).send('<Response><Message>Disculpa, no pude escuchar bien. ¿Me escribes? 🎙️</Message></Response>');
      }
    }

    // 2. CARGAR DATOS (incluyendo relación especialista-servicio)
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    // IMPORTANTE: Cargar especialistas con sus servicios asignados
    const { data: especialistas } = await supabase
      .from('especialistas')
      .select('id, nombre, expertise, servicios, nivel, activo')
      .eq('activo', true); // Solo activos

    const { data: servicios } = await supabase
      .from('servicios')
      .select('id, nombre, precio, duracion, categoria');

    // 3. FECHAS
    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);

    // 4. HISTORIAL
    const { data: historialCompleto } = await supabase
      .from('conversaciones')
      .select('rol, contenido, created_at')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(15);

    // 5. DETECTAR FECHA Y HORA
    let intencionFecha = null;
    let fechaExplicita = null;
    let horaDetectada = null;
    
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

    for (const msg of historialCompleto || []) {
      if (msg.rol === 'user') {
        const contenidoLower = msg.contenido.toLowerCase();
        if (contenidoLower.includes('mañana') || contenidoLower.includes('manana')) {
          intencionFecha = 'manana';
        } else if (contenidoLower.includes('hoy')) {
          intencionFecha = 'hoy';
        }
        const matchFecha = msg.contenido.match(/(\d{4}-\d{2}-\d{2})/);
        if (matchFecha) fechaExplicita = matchFecha[1];
      }
    }
    
    const textoLower = textoUsuario.toLowerCase();
    if (textoLower.includes('mañana') || textoLower.includes('manana')) intencionFecha = 'manana';
    else if (textoLower.includes('hoy')) intencionFecha = 'hoy';

    // 6. DETERMINAR FECHA FINAL
    let fechaFinal;
    if (fechaExplicita && fechaExplicita >= fechaHoy) {
      fechaFinal = fechaExplicita;
    } else if (intencionFecha === 'manana') {
      fechaFinal = fechaManana;
    } else if (intencionFecha === 'hoy') {
      fechaFinal = fechaHoy;
    } else {
      fechaFinal = fechaHoy;
    }

    // 7. BUSCAR RECOMENDACIONES PREVIAS Y DETECTAR ELECCIÓN
    const recomendacionesPrevias = await obtenerRecomendacionesGuardadas(userPhone);
    const eleccionDetectada = detectarEleccionEspecialista(textoUsuario, recomendacionesPrevias);
    
    console.log('📊 Contexto:', {
      cliente: cliente?.nombre || 'NUEVO',
      fecha: fechaFinal,
      hora: horaDetectada,
      eleccion: eleccionDetectada?.nombre || null
    });

    // 8. CONSULTAR AGENDA
    const citasOcupadas = await obtenerCitasOcupadas(fechaFinal);
    const historialFormateado = historialCompleto?.slice(0, 6).reverse().map(h => 
      `${h.rol === 'user' ? 'Cliente' : 'Aura'}: ${h.contenido}`
    ).join('\n') || '';

    // 9. SYSTEM PROMPT
    let systemPrompt = `Eres Aura, la mejor coordinadora de agenda de belleza y bienestar. Eres humana, cálida, profesional y eficiente.

[CONTEXTO]
Fecha cita: ${formatearFecha(fechaFinal)}
Cliente: ${cliente?.nombre ? 'Registrado: ' + cliente.nombre : 'NUEVO - preguntar nombre'}
Hora solicitada: ${horaDetectada || 'Por confirmar'}

[REGLAS DE ORO]
1. Si el cliente es NUEVO, pide su nombre amablemente antes de continuar.
2. NUNCA recomiendes especialistas que no hagan el servicio solicitado.
3. Siempre ofrece MÍNIMO 2 opciones de especialistas calificados.
4. Cuando elija, confirma inmediatamente sin volver a preguntar.
5. Sé conversacional, usa emojis naturales, no robótica.

[ESPECIALISTAS Y SUS SERVICIOS]
${especialistas?.map(e => `- ${e.nombre}: ${e.expertise} | Servicios: ${Array.isArray(e.servicios) ? e.servicios.join(', ') : 'Ver base de datos'}`).join('\n')}

[SERVICIOS]
${servicios?.map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion}min`).join('\n')}`;

    // 10. LLAMADA OPENAI
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.2,
      max_tokens: 600
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let reply = aiRes.data.choices[0].message.content;
    
    // 11. PROCESAR RESPUESTA
    const jsonMatch = reply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})/);
    let data = {};
    let mensajeFinal = reply.split('DATA_JSON')[0].trim();

    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1]);
        data.cita_fecha = fechaFinal; // Forzar fecha
        
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

        const servicio = servicios?.find(s => 
          s.nombre.toLowerCase().includes((data.cita_servicio || '').toLowerCase())
        );

        // ============ SOBREESCRIBIR CON ELECCIÓN DETECTADA ============
        if (eleccionDetectada && !data.cita_especialista) {
          data.cita_especialista = eleccionDetectada.nombre;
          data.accion = 'agendar';
          if (!data.cita_hora && eleccionDetectada.horarios?.length > 0) {
            data.cita_hora = eleccionDetectada.horarios[0];
          }
          console.log('✅ Elección forzada:', eleccionDetectada.nombre);
        }

        // ============ RECOMENDACIÓN INTELIGENTE ============
        if ((data.necesita_recomendacion || !data.cita_especialista) && servicio && !eleccionDetectada) {
          
          const resultado = await recomendarEspecialistasOptimizado(
            especialistas,
            data.cita_servicio,
            fechaFinal,
            data.cita_hora || horaDetectada,
            servicio.duracion,
            citasOcupadas,
            servicios
          );
          
          // Guardar recomendaciones
          if (resultado.recomendaciones) {
            const recsGuardar = resultado.recomendaciones.map(r => ({
              id: r.id,
              nombre: r.nombre,
              horarios: r.estaDisponible ? [data.cita_hora || horaDetectada] : r.alternativasHorario
            }));
            
            await supabase.from('conversaciones').insert({
              telefono: userPhone,
              rol: 'system',
              contenido: `RECOMENDACIONES_GUARDADAS:${JSON.stringify(recsGuardar)}`,
              created_at: new Date().toISOString()
            });
          }
          
          mensajeFinal = generarMensajeRecomendacionHumano(
            resultado, 
            data.cita_servicio, 
            fechaFinal, 
            data.cita_hora || horaDetectada,
            cliente,
            servicio
          );
        }

        // ============ AGENDAR ============
        else if ((data.accion === 'agendar' || eleccionDetectada) && data.cita_hora && data.cita_especialista) {
          
          const especialista = especialistas?.find(e => 
            e.nombre.toLowerCase().includes(data.cita_especialista.toLowerCase())
          );

          if (!especialista) {
            mensajeFinal = `No encontré a ${data.cita_especialista}. ¿Podrías elegir entre las opciones que te mostré? 😊`;
          } else if (!servicio) {
            mensajeFinal = `¿Qué servicio es exactamente? Tenemos: ${servicios?.map(s => s.nombre).join(', ')}.`;
          } else {
            // Verificar que el especialista SÍ hace este servicio
            if (!especialistaPuedeHacerServicio(especialista, servicio.nombre)) {
              mensajeFinal = `Ups, ${especialista.nombre} no realiza ${servicio.nombre}. Déjame recomendarte a alguien que sí lo hace...`;
              
              // Forzar nueva recomendación
              const resultado = await recomendarEspecialistasOptimizado(
                especialistas, servicio.nombre, fechaFinal, data.cita_hora, 
                servicio.duracion, citasOcupadas, servicios
              );
              
              mensajeFinal = generarMensajeRecomendacionHumano(resultado, servicio.nombre, fechaFinal, data.cita_hora, cliente, servicio);
            } else {
              // Verificar disponibilidad
              const check = await verificarDisponibilidadEspecialista(
                fechaFinal, data.cita_hora, servicio.duracion, 
                especialista.nombre, citasOcupadas
              );
              
              if (!check.disponible) {
                const slots = await obtenerSlotsAlternativos(
                  fechaFinal, servicio.duracion, citasOcupadas, especialista
                );
                const alternativas = slots.slice(0, 3).map(h => formatearHora(h)).join(', ');
                mensajeFinal = `${especialista.nombre} no tiene disponible las ${formatearHora(data.cita_hora)}. ¿Te funciona: ${alternativas}?`;
              } else {
                // CREAR CITA
                const fechaHoraISO = `${fechaFinal}T${data.cita_hora}:00-05:00`;
                
                const { data: citaSupabase } = await supabase
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

                await crearCitaAirtable({
                  telefono: userPhone,
                  nombre: cliente?.nombre || data.nombre,
                  apellido: cliente?.apellido || "",
                  fecha: fechaFinal,
                  hora: data.cita_hora,
                  servicio: servicio.nombre,
                  especialista: especialista.nombre,
                  precio: servicio.precio,
                  duracion: servicio.duracion,
                  supabase_id: citaSupabase?.id
                });

                // Mensaje humano de confirmación
                mensajeFinal = `¡Listo${cliente?.nombre ? ` ${cliente.nombre}` : ''}! 🎉\n\nTu cita está confirmada:\n\n📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(data.cita_hora)}\n💅 ${servicio.nombre}\n✨ Con ${especialista.nombre}\n💰 $${servicio.precio} | ⏱️ ${servicio.duracion} min\n\nNos vemos pronto. ¡Te va a encantar el resultado! 😊✨`;
                
                // Limpiar recomendaciones
                await supabase.from('conversaciones').insert({
                  telefono: userPhone,
                  rol: 'system',
                  contenido: 'RECOMENDACIONES_GUARDADAS:[]',
                  created_at: new Date().toISOString()
                });
              }
            }
          }
        }
        
        // ============ CANCELAR ============
        else if (data.accion === 'cancelar') {
          const ok = await cancelarCitaAirtable(userPhone);
          mensajeFinal = ok 
            ? `✅ He cancelado tu cita. ¿Te gustaría agendar algo nuevo?`
            : `No encontré citas activas para cancelar. ¿Necesitas ayuda con algo más?`;
        }
        
        // ============ REAGENDAR ============
        else if (data.accion === 'reagendar') {
          const ok = await reagendarCitaAirtable(userPhone, { ...data, cita_fecha: fechaFinal });
          mensajeFinal = ok
            ? `✅ Perfecto, cambié tu cita para ${formatearFecha(fechaFinal)} a las ${formatearHora(data.cita_hora)}.`
            : `No pude encontrar tu cita activa. ¿Tienes una reserva confirmada?`;
        }

      } catch (e) {
        console.error('Error:', e);
        mensajeFinal = "Ups, se me cruzaron los cables un segundo. ¿Me repites? 😅";
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
    console.error('❌ Error crítico:', err);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento. ¿Me repites? 🌸</Message></Response>');
  }
}
