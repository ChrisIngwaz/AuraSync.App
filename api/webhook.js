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

function normalizarTexto(texto) {
  return texto.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
}

// ============ DETECCIÓN INTELIGENTE ============

function detectarServicio(mensaje, serviciosDisponibles) {
  const texto = normalizarTexto(mensaje);
  
  for (const servicio of serviciosDisponibles) {
    if (texto.includes(normalizarTexto(servicio.nombre))) return servicio;
  }
  
  const mapa = {
    'corte': ['corte', 'cortarme', 'pelo', 'cabello', 'barba', 'fade', 'taper'],
    'tinte': ['tinte', 'color', 'mechas', 'balayage', 'decolorar'],
    'manicura': ['manicura', 'manos', 'unas', 'gel', 'acrílico', 'nail'],
    'pedicura': ['pedicura', 'pies', 'spa pies', 'callos'],
    'facial': ['facial', 'cara', 'rostro', 'limpieza', 'acne'],
    'maquillaje': ['maquillaje', 'makeup', 'social', 'novia', 'evento'],
    'peinado': ['peinado', 'peinarme', 'recogido', 'ondas', 'volumen'],
    'depilacion': ['depilacion', 'wax', 'cera', 'laser']
  };
  
  for (const [tipo, keywords] of Object.entries(mapa)) {
    if (keywords.some(k => texto.includes(k))) {
      return serviciosDisponibles.find(s => normalizarTexto(s.nombre).includes(tipo));
    }
  }
  
  return null;
}

function detectarFecha(mensaje) {
  const texto = normalizarTexto(mensaje);
  if (texto.includes('manana')) return 'manana';
  if (texto.includes('hoy')) return 'hoy';
  const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
  for (const dia of dias) if (texto.includes(dia)) return dia;
  return null;
}

function detectarHora(mensaje) {
  const patrones = [
    /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    /(\d{1,2})\s*(am|pm)/i,
    /a\s+las\s+(\d{1,2})(?:\s*de\s+la\s*(manana|tarde|noche))?/i,
    /(\d{1,2})\s+de\s+la\s+(manana|tarde|noche)/i
  ];
  
  for (const patron of patrones) {
    const match = mensaje.match(patron);
    if (match) {
      let horas = parseInt(match[1]);
      let minutos = match[2] || '00';
      let periodo = (match[3] || '').toLowerCase();
      if (match[4]) periodo = match[4].includes('tarde') || match[4].includes('noche') ? 'pm' : 'am';
      if (periodo === 'pm' && horas < 12) horas += 12;
      if (periodo === 'am' && horas === 12) horas = 0;
      if (horas >= 9 && horas <= 18) {
        return `${String(horas).padStart(2, '0')}:${minutos.toString().padStart(2, '0')}`;
      }
    }
  }
  return null;
}

function detectarFechaNacimiento(mensaje) {
  const patrones = [
    /(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})/i,
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/
  ];
  
  const meses = {
    'enero': '01', 'febrero': '02', 'marzo': '03', 'abril': '04',
    'mayo': '05', 'junio': '06', 'julio': '07', 'agosto': '08',
    'septiembre': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
  };
  
  for (const patron of patrones) {
    const match = mensaje.match(patron);
    if (match) {
      let dia, mes, anio;
      if (match[3].length === 4) {
        dia = match[1].padStart(2, '0');
        mes = meses[match[2].toLowerCase()] || match[2].padStart(2, '0');
        anio = match[3];
      } else {
        anio = match[1];
        mes = match[2].padStart(2, '0');
        dia = match[3].padStart(2, '0');
      }
      return `${anio}-${mes}-${dia}`;
    }
  }
  return null;
}

function extraerDatosRegistro(mensaje) {
  const texto = mensaje.trim();
  const lineas = texto.split(/[\n,]+/).map(l => l.trim()).filter(l => l.length > 0);
  
  let nombre = null, apellido = null, fechaNacimiento = null, ciudad = null;
  
  for (const linea of lineas) {
    const lineaLower = linea.toLowerCase();
    
    if (!nombre && (lineaLower.includes('nombre') || lineaLower.includes('llamo') || lineaLower.includes('soy'))) {
      const match = linea.match(/(?:nombre|llamo|soy)[\s:]*([a-záéíóúñ]+)/i);
      if (match) nombre = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
    
    if (!apellido && (lineaLower.includes('apellido') || lineaLower.includes('mi apellido'))) {
      const match = linea.match(/(?:apellido)[\s:]*([a-záéíóúñ]+)/i);
      if (match) apellido = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
    
    if (!fechaNacimiento && (lineaLower.includes('nacimiento') || lineaLower.includes('nací') || lineaLower.includes('cumpleaños'))) {
      fechaNacimiento = detectarFechaNacimiento(linea);
    }
    
    if (!ciudad && (lineaLower.includes('ciudad') || lineaLower.includes('vivo en') || lineaLower.includes('soy de'))) {
      const match = linea.match(/(?:ciudad|vivo en|soy de)[\s:]*([a-záéíóúñ\s]+)/i);
      if (match) ciudad = match[1].trim().charAt(0).toUpperCase() + match[1].trim().slice(1);
    }
  }
  
  if (!nombre) {
    const nombreMatch = mensaje.match(/(?:me llamo|soy|mi nombre es|llamame)\s+([a-záéíóúñ]{2,15})/i);
    if (nombreMatch) nombre = nombreMatch[1].charAt(0).toUpperCase() + nombreMatch[1].slice(1);
  }
  
  if (!fechaNacimiento) fechaNacimiento = detectarFechaNacimiento(mensaje);
  
  if (!ciudad) {
    const ciudades = ['guayaquil', 'quito', 'cuenca', 'manta', 'ambato', 'portoviejo', 'machala', 'santo domingo', 'durán', 'quevedo'];
    for (const c of ciudades) {
      if (mensaje.toLowerCase().includes(c)) {
        ciudad = c.charAt(0).toUpperCase() + c.slice(1);
        break;
      }
    }
  }
  
  return { nombre, apellido, fechaNacimiento, ciudad, completo: nombre && apellido && fechaNacimiento && ciudad };
}

function detectarEleccionEspecialista(mensaje, recomendados) {
  const texto = normalizarTexto(mensaje);
  
  if (texto.includes('primero') || texto.includes('1') || texto.includes('uno')) return recomendados[0];
  if ((texto.includes('segundo') || texto.includes('2') || texto.includes('dos')) && recomendados.length > 1) return recomendados[1];
  
  for (const rec of recomendados) {
    const nombreLower = rec.nombre.toLowerCase();
    const primerNombre = nombreLower.split(' ')[0];
    if (texto.includes(nombreLower) || (primerNombre.length > 3 && texto.includes(primerNombre))) return rec;
  }
  return null;
}

// ============ LÓGICA DE ESPECIALISTAS ============

const MAPEO_EXPERTISE = {
  'corte': ['corte', 'barbero', 'estilista', 'degradado', 'fade', 'taper', 'peluquero'],
  'tinte': ['color', 'tinte', 'mechas', 'balayage', 'colorista'],
  'manicura': ['manicura', 'manos', 'uñas', 'nail', 'gel'],
  'pedicura': ['pedicura', 'pies', 'podología', 'spa pies'],
  'facial': ['facial', 'rostro', 'limpieza', 'tratamiento'],
  'maquillaje': ['maquillaje', 'makeup', 'social', 'novia'],
  'peinado': ['peinado', 'evento', 'volumen', 'recogido']
};

function puedeHacerServicio(especialista, servicioNombre) {
  if (!especialista?.expertise) return false;
  const servicioNorm = normalizarTexto(servicioNombre);
  const expertiseNorm = normalizarTexto(especialista.expertise);
  
  let keywords = [];
  for (const [cat, kws] of Object.entries(MAPEO_EXPERTISE)) {
    if (servicioNorm.includes(cat)) { keywords = kws; break; }
  }
  if (keywords.length === 0) keywords = [servicioNorm];
  return keywords.some(kw => expertiseNorm.includes(kw));
}

function generarDescripcionPersuasiva(especialista, servicio) {
  const servicioNorm = normalizarTexto(servicio);
  const plantillas = {
    'corte': ["Especialista en cortes estructurales y degradados modernos", "Barbero experto en fades y tapers precisos", "Estilista con ojo para las tendencias actuales"],
    'tinte': ["Colorista experto en balayage y mechas", "Especialista en transformaciones de color", "Artista del color con técnicas de última generación"],
    'manicura': ["Especialista en manicura gel y nail art creativo", "Experto en cuidado de manos y uñas", "Artista en uñas con técnicas de spa"],
    'pedicura': ["Especialista en pedicura spa y cuidado podológico", "Experto en tratamientos de pies con relajación", "Técnico en pedicura terapéutica"],
    'peinado': ["Especialista en peinados de evento con volumen", "Artista en recogidos elegantes y ondas", "Experto en styling con productos premium"],
    'facial': ["Especialista en tratamientos faciales personalizados", "Experto en limpieza profunda e hidratación", "Terapeuta facial con enfoque holístico"],
    'maquillaje': ["Maquillista profesional para eventos sociales", "Especialista en maquillaje de novia", "Artista del maquillaje con técnicas de pasarela"]
  };
  
  for (const [cat, descs] of Object.entries(plantillas)) {
    if (servicioNorm.includes(cat)) {
      const idx = (especialista.id?.length || 0) % descs.length;
      return descs[idx];
    }
  }
  return especialista.expertise || "Especialista certificado";
}

// ============ BASE DE DATOS ============

async function cargarDatos() {
  const [espRes, servRes] = await Promise.all([
    supabase.from('especialistas').select('*'),
    supabase.from('servicios').select('*')
  ]);
  return { especialistas: espRes.data || [], servicios: servRes.data || [] };
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

async function guardarEstado(telefono, estado) {
  await supabase.from('conversaciones').insert({
    telefono, rol: 'system', contenido: `ESTADO:${JSON.stringify(estado)}`,
    created_at: new Date().toISOString()
  });
}

async function obtenerEstado(telefono) {
  try {
    const { data } = await supabase
      .from('conversaciones').select('contenido')
      .eq('telefono', telefono).eq('rol', 'system')
      .ilike('contenido', 'ESTADO:%')
      .order('created_at', { ascending: false }).limit(1).single();
    if (data?.contenido) return JSON.parse(data.contenido.replace('ESTADO:', ''));
    return null;
  } catch (e) { return null; }
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
          "Servicio": datos.servicio, "Fecha": fechaUTC, "Hora": datos.hora,
          "Especialista": datos.especialista, "Teléfono": datos.telefono,
          "Estado": "Confirmada", "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion, "ID_Supabase": datos.supabase_id
        }
      }]
    };
    
    await axios.post(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
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
    await axios.patch(url, { records: [{ id: record.id, fields: { "Estado": "Cancelada" } }] }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
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

// NUEVO: REAGENDAR CITA - FUNCIONALIDAD COMPLETA
async function reagendarCita(telefono, nuevaFecha, nuevaHora, nuevoEspecialista = null) {
  try {
    // 1. Buscar cita activa en Airtable
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return { ok: false, error: 'no_cita' };

    const record = busqueda.data.records[0];
    const citaActual = record.fields;
    
    // 2. Verificar disponibilidad del nuevo horario
    const citasOcupadas = await obtenerCitasOcupadas(nuevaFecha);
    const duracion = citaActual['Duración estimada (minutos)'] || 60;
    
    const [h, m] = nuevaHora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + duracion;
    
    const especialistaFinal = nuevoEspecialista || citaActual.Especialista;
    
    for (const cita of citasOcupadas) {
      if (cita.especialista !== especialistaFinal) continue;
      
      const [hc, mc] = cita.hora.split(':').map(Number);
      const inicioExistente = hc * 60 + mc;
      const finExistente = inicioExistente + cita.duracion;
      
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        return { ok: false, error: 'conflicto', especialista: especialistaFinal };
      }
    }
    
    // 3. Actualizar Airtable
    const [hNew, minNew] = nuevaHora.split(':').map(Number);
    const [anio, mes, dia] = nuevaFecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, hNew + 5, minNew, 0)).toISOString();
    
    await axios.patch(url, {
      records: [{
        id: record.id,
        fields: {
          "Fecha": fechaUTC,
          "Hora": nuevaHora,
          "Especialista": especialistaFinal
        }
      }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    // 4. Actualizar Supabase
    if (record.fields.ID_Supabase) {
      await supabase.from('citas')
        .update({ 
          fecha_hora: `${nuevaFecha}T${nuevaHora}:00-05:00`,
          especialista_id: nuevoEspecialista ? (await supabase.from('especialistas').select('id').eq('nombre', nuevoEspecialista).single()).data?.id : undefined
        })
        .eq('id', record.fields.ID_Supabase);
    }
    
    return { ok: true };
  } catch (error) {
    console.error('Error reagendando:', error.message);
    return { ok: false, error: 'exception' };
  }
}

// ============ VERIFICACIÓN CRÍTICA DE DISPONIBILIDAD ============

async function verificarDisponibilidadReal(fecha, hora, duracion, especialistaNombre) {
  const citasOcupadas = await obtenerCitasOcupadas(fecha);
  
  const [h, m] = hora.split(':').map(Number);
  const inicio = h * 60 + m;
  const fin = inicio + duracion;
  
  for (const cita of citasOcupadas) {
    if (cita.especialista !== especialistaNombre) continue;
    
    const [hc, mc] = cita.hora.split(':').map(Number);
    const inicioExistente = hc * 60 + mc;
    const finExistente = inicioExistente + cita.duracion;
    
    if (inicio < finExistente && fin > inicioExistente) {
      return { disponible: false, conflicto: cita };
    }
  }
  
  return { disponible: true };
}

// ============ OPENAI PARA TONO HUMANO ============

async function humanizarMensaje(mensajeBase, contexto, historial) {
  if (!CONFIG.OPENAI_API_KEY) return mensajeBase;
  
  try {
    const systemPrompt = `Eres Aura, coordinadora de agenda de un salón de belleza premium en Ecuador.

PERSONALIDAD:
- Cálida, profesional, eficiente
- Ecuatoriana: usa "¿Te funciona?", "¿Te parece?", "perfecto"
- Saluda por nombre cuando lo sabes
- Máximo 2-3 emojis por mensaje
- NUNCA inventes datos, mantén la información exacta que te dan

RESTRICCIÓN CRÍTICA: Mantén los nombres de especialistas, precios, horarios y servicios EXACTAMENTE como te los dan.`;

    const userPrompt = `Mensaje base (información exacta a mantener):
"${mensajeBase}"

Contexto:
- Cliente: ${contexto.cliente || 'Nuevo'}
- Paso: ${contexto.paso || 'inicio'}
- Servicio: ${contexto.servicio?.nombre || 'Por definir'}

Reescribe manteniendo TODA la información exacta, solo mejora el tono para que suene humano y cálido.`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 400
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
      timeout: 5000
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    return mensajeBase;
  }
}

// ============ GENERADORES DE MENSAJES ============

function mensajeBienvenidaNuevo() {
  return `¡Hola! 😊 Bienvenido a nuestro salón. Soy Aura, tu coordinadora.\n\nPara darte la mejor experiencia, necesito registrarte. Por favor dime:\n• Tu nombre\n• Tu apellido\n• Tu fecha de nacimiento (ej: 15 de abril de 1990)\n• Tu ciudad\n\nPuedes enviarme todo en un solo mensaje.`;
}

function mensajeDatosPendientes(datos) {
  const faltantes = [];
  if (!datos.nombre) faltantes.push('nombre');
  if (!datos.apellido) faltantes.push('apellido');
  if (!datos.fechaNacimiento) faltantes.push('fecha de nacimiento');
  if (!datos.ciudad) faltantes.push('ciudad');
  return `Gracias. 😊 Me falta conocer tu ${faltantes.join(', ')}. ¿Me lo compartes?`;
}

function mensajeRegistroCompleto(nombre) {
  return `¡Perfecto ${nombre}! ✅ Ya estás registrado. Ahora sí, ¿qué servicio te gustaría agendar?\n\nTenemos:\n• Corte de Cabello\n• Tinte/Color\n• Manicura\n• Pedicura\n• Facial\n• Maquillaje\n• Peinado para eventos`;
}

function mensajeServicio(cliente) {
  return `¡Hola ${cliente.nombre}! 😊 ¿Qué servicio te gustaría hoy? Tenemos corte, tinte, manicura, pedicura, facial, maquillaje y peinados.`;
}

function mensajeHora(servicio, fecha, cliente) {
  return `Excelente elección. Un ${servicio.nombre} está en $${servicio.precio} y dura ${servicio.duracion} minutos. ¿Para qué hora lo necesitas? Nuestro horario es de 9 AM a 6 PM.`;
}

function mensajeRecomendacion(especialistas, servicio, fecha, hora, cliente) {
  const fechaTexto = formatearFecha(fecha);
  const horaTexto = formatearHora(hora);
  
  let msg = `¡Perfecto ${cliente.nombre}! ✨ Para tu ${servicio.nombre} el ${fechaTexto} a las ${horaTexto}, tengo estas opciones:\n\n`;
  
  especialistas.forEach((esp, idx) => {
    const label = idx === 0 ? '🥇 Opción recomendada' : '🥈 Alternativa ideal';
    msg += `${label}:\n**${esp.nombre}** — ${esp.descripcion}\n`;
    
    if (esp.disponible) msg += `✅ Confirmado para ${horaTexto}\n`;
    else if (esp.alternativas?.length > 0) msg += `⏰ También: ${esp.alternativas.slice(0, 2).map(h => formatearHora(h)).join(', ')}\n`;
    
    if (esp.citasHoy === 0) msg += `💎 Agenda libre — atención exclusiva\n`;
    else if (esp.citasHoy < 3) msg += `🟡 Poca carga — atención personalizada\n`;
    msg += `\n`;
  });
  
  msg += `¿Con quién prefieres? Dime el nombre o "primero/segundo" 👇`;
  return msg;
}

function mensajeConfirmacion(cliente, servicio, especialista, fecha, hora) {
  return `¡Listo ${cliente.nombre}! 🎉 Tu cita está confirmada:\n\n📅 ${formatearFecha(fecha)} a las ${formatearHora(hora)}\n💇‍♀️ ${servicio.nombre}\n✨ Con ${especialista.nombre}\n💰 $${servicio.precio} | ⏱️ ${servicio.duracion} min\n\n¡Te esperamos! 😊✨`;
}

function mensajeNoEspecialistas(servicio) {
  return `Lo siento, no tenemos especialistas disponibles para ${servicio} en este momento. ¿Te gustaría otro servicio o fecha diferente?`;
}

function mensajeNoEntiendo() {
  return `Disculpa, no entendí bien. ¿Podrías repetirme? 😊 Estoy aquí para ayudarte.`;
}

// ============ WEBHOOK PRINCIPAL ============

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : '';
  if (!userPhone) return res.status(200).send('<Response></Response>');

  try {
    // 1. PROCESAR ENTRADA
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
        return res.status(200).send('<Response><Message>Disculpa, no pude escuchar bien. ¿Me escribes? 🎙️</Message></Response>');
      }
    }

    // 2. CARGAR DATOS DE TODAS LAS TABLAS
    const [{ data: cliente }, { especialistas, servicios }, estadoPrevio] = await Promise.all([
      supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle(),
      cargarDatos(),
      obtenerEstado(userPhone)
    ]);

    const { data: historial } = await supabase
      .from('conversaciones').select('rol, contenido')
      .eq('telefono', userPhone).order('created_at', { ascending: false }).limit(5);

    // 3. MÁQUINA DE ESTADOS
    let estado = estadoPrevio || { paso: 'inicio' };
    let mensajeBase = '';
    let nuevoEstado = { ...estado };
    const texto = normalizarTexto(textoUsuario);

    // DETECTAR CANCELACIÓN
    if (texto.includes('cancelar') || texto.includes('anular')) {
      const ok = await cancelarCitaAirtable(userPhone);
      mensajeBase = ok ? `He cancelado tu cita. ¿Te gustaría agendar algo nuevo?` : `No encontré citas activas para cancelar.`;
      nuevoEstado = { paso: 'inicio' };
    }
    // NUEVO: DETECTAR REAGENDAR
    else if (texto.includes('reagendar') || texto.includes('cambiar fecha') || texto.includes('cambiar hora') || texto.includes('mover cita')) {
      mensajeBase = `Claro, puedo ayudarte a reagendar. ¿Para qué nueva fecha y hora te gustaría mover tu cita?`;
      nuevoEstado = { paso: 'reagendando_solicitar_fecha', datosReagenda: {} };
    }
    
    // ===== ESTADO: INICIO =====
    else if (estado.paso === 'inicio') {
      if (!cliente) {
        mensajeBase = mensajeBienvenidaNuevo();
        nuevoEstado = { paso: 'registrando', datosRegistro: {} };
      } else {
        const servicioDetectado = detectarServicio(textoUsuario, servicios);
        if (servicioDetectado) {
          const fechaRel = detectarFecha(textoUsuario);
          const horaDetectada = detectarHora(textoUsuario);
          const fecha = fechaRel === 'manana' ? getFechaEcuador(1) : getFechaEcuador(0);
          
          if (horaDetectada) {
            mensajeBase = await generarRecomendaciones(especialistas, servicioDetectado, fecha, horaDetectada, cliente, userPhone, nuevoEstado);
          } else {
            mensajeBase = mensajeHora(servicioDetectado, fecha, cliente);
            nuevoEstado = { paso: 'esperando_hora', servicio: servicioDetectado, fecha, nombre: cliente.nombre };
          }
        } else {
          mensajeBase = mensajeServicio(cliente);
          nuevoEstado = { paso: 'esperando_servicio', nombre: cliente.nombre };
        }
      }
    }
    
    // ===== ESTADO: REGISTRANDO =====
    else if (estado.paso === 'registrando') {
      const datosExtraidos = extraerDatosRegistro(textoUsuario);
      const datosActuales = { ...estado.datosRegistro, ...datosExtraidos };
      
      if (datosActuales.nombre && datosActuales.apellido && datosActuales.fechaNacimiento && datosActuales.ciudad) {
        const { data: nuevoCliente, error } = await supabase.from('clientes').insert({
          telefono: userPhone, nombre: datosActuales.nombre, apellido: datosActuales.apellido,
          fecha_nacimiento: datosActuales.fechaNacimiento, ciudad: datosActuales.ciudad,
          created_at: new Date().toISOString()
        }).select().single();
        
        if (error) {
          mensajeBase = `Hubo un problema con tu registro. ¿Podemos intentar de nuevo?`;
          nuevoEstado = { paso: 'registrando', datosRegistro: datosActuales };
        } else {
          mensajeBase = mensajeRegistroCompleto(datosActuales.nombre);
          nuevoEstado = { paso: 'esperando_servicio', nombre: datosActuales.nombre };
        }
      } else {
        mensajeBase = mensajeDatosPendientes(datosActuales);
        nuevoEstado = { paso: 'registrando', datosRegistro: datosActuales };
      }
    }
    
    // NUEVOS ESTADOS PARA REAGENDAR
    else if (estado.paso === 'reagendando_solicitar_fecha') {
      const fechaRel = detectarFecha(textoUsuario);
      const horaDetectada = detectarHora(textoUsuario);
      const fecha = fechaRel === 'manana' ? getFechaEcuador(1) : (fechaRel === 'hoy' ? getFechaEcuador(0) : getFechaEcuador(1));
      
      if (horaDetectada) {
        // Intentar reagendar directamente
        const resultado = await reagendarCita(userPhone, fecha, horaDetectada);
        if (resultado.ok) {
          mensajeBase = `✅ ¡Listo! He movido tu cita para ${formatearFecha(fecha)} a las ${formatearHora(horaDetectada)}. ¿Algo más en lo que pueda ayudarte?`;
          nuevoEstado = { paso: 'inicio' };
        } else if (resultado.error === 'no_cita') {
          mensajeBase = `No encontré una cita activa para reagendar. ¿Te gustaría agendar una nueva?`;
          nuevoEstado = { paso: 'inicio' };
        } else if (resultado.error === 'conflicto') {
          mensajeBase = `${resultado.especialista} no está disponible a esa hora. ¿Te gustaría otra hora o fecha?`;
          nuevoEstado = { paso: 'reagendando_solicitar_fecha', datosReagenda: { fechaPropuesta: fecha } };
        }
      } else if (fechaRel) {
        mensajeBase = `Perfecto, para ${fechaRel === 'manana' ? 'mañana' : fechaRel}. ¿A qué hora?`;
        nuevoEstado = { paso: 'reagendando_solicitar_hora', datosReagenda: { fecha } };
      } else {
        mensajeBase = `¿Para qué fecha te gustaría reagendar? Puedes decirme "mañana" o un día específico.`;
      }
    }
    
    else if (estado.paso === 'reagendando_solicitar_hora') {
      const hora = detectarHora(textoUsuario);
      if (hora) {
        const fecha = estado.datosReagenda?.fecha || getFechaEcuador(1);
        const resultado = await reagendarCita(userPhone, fecha, hora);
        
        if (resultado.ok) {
          mensajeBase = `✅ ¡Perfecto! Tu cita ha sido reagendada para ${formatearFecha(fecha)} a las ${formatearHora(hora)}.`;
          nuevoEstado = { paso: 'inicio' };
        } else if (resultado.error === 'conflicto') {
          mensajeBase = `Ese horario no está disponible. ¿Te gustaría otra hora?`;
          nuevoEstado = estado;
        } else {
          mensajeBase = `No pude reagendar. ¿Te gustaría intentar con otra fecha?`;
          nuevoEstado = { paso: 'inicio' };
        }
      } else {
        mensajeBase = `¿A qué hora? Por ejemplo: "10 de la mañana" o "3pm"`;
      }
    }
    
    // ===== ESTADO: ESPERANDO_SERVICIO =====
    else if (estado.paso === 'esperando_servicio') {
      const servicio = detectarServicio(textoUsuario, servicios);
      if (servicio) {
        const fechaRel = detectarFecha(textoUsuario);
        const horaDetectada = detectarHora(textoUsuario);
        const fecha = fechaRel === 'manana' ? getFechaEcuador(1) : getFechaEcuador(0);
        
        if (horaDetectada) {
          mensajeBase = await generarRecomendaciones(especialistas, servicio, fecha, horaDetectada, { nombre: estado.nombre }, userPhone, nuevoEstado);
        } else {
          mensajeBase = mensajeHora(servicio, fecha, { nombre: estado.nombre });
          nuevoEstado = { paso: 'esperando_hora', servicio, fecha, nombre: estado.nombre };
        }
      } else {
        mensajeBase = `No reconocí ese servicio. ¿Podrías decirme cuál? Tenemos: corte, tinte, manicura, pedicura, facial, maquillaje o peinado.`;
        nuevoEstado = estado;
      }
    }
    
    // ===== ESTADO: ESPERANDO_HORA =====
    else if (estado.paso === 'esperando_hora') {
      const hora = detectarHora(textoUsuario);
      if (hora) {
        mensajeBase = await generarRecomendaciones(especialistas, estado.servicio, estado.fecha, hora, { nombre: estado.nombre }, userPhone, nuevoEstado);
      } else {
        mensajeBase = `¿A qué hora te gustaría? Nuestro horario es de 9 AM a 6 PM.`;
        nuevoEstado = estado;
      }
    }
    
    // ===== ESTADO: ESPERANDO_ESPECIALISTA =====
    else if (estado.paso === 'esperando_especialista') {
      const elegido = detectarEleccionEspecialista(textoUsuario, estado.especialistasRecomendados);
      
      if (elegido) {
        const espCompleto = especialistas.find(e => e.id === elegido.id || e.nombre === elegido.nombre);
        
        if (espCompleto && puedeHacerServicio(espCompleto, estado.servicio.nombre)) {
          // CRÍTICO: Verificar disponibilidad REAL justo antes de crear
          const verificacion = await verificarDisponibilidadReal(
            estado.fecha, 
            estado.hora, 
            estado.servicio.duracion, 
            espCompleto.nombre
          );
          
          if (!verificacion.disponible) {
            mensajeBase = `Ups, ${espCompleto.nombre} acaba de ser reservado a esa hora. Déjame buscarte alternativas...`;
            mensajeBase = await generarRecomendaciones(
              especialistas, estado.servicio, estado.fecha, estado.hora,
              { nombre: estado.nombre }, userPhone, nuevoEstado, true
            );
          } else {
            // CREAR CITA
            const { servicio, fecha, hora, nombre } = estado;
            const fechaHoraISO = `${fecha}T${hora}:00-05:00`;
            
            const { data: clienteActual } = await supabase.from('clientes').select('id').eq('telefono', userPhone).single();
            
            const { data: citaDB } = await supabase.from('citas').insert({
              cliente_id: clienteActual?.id,
              servicio_id: servicio.id,
              especialista_id: espCompleto.id,
              fecha_hora: fechaHoraISO,
              estado: 'Confirmada',
              created_at: new Date().toISOString()
            }).select().single();
            
            await crearCitaAirtable({
              telefono: userPhone, nombre, apellido: cliente?.apellido || '',
              fecha, hora, servicio: servicio.nombre, especialista: espCompleto.nombre,
              precio: servicio.precio, duracion: servicio.duracion, supabase_id: citaDB?.id
            });
            
            mensajeBase = mensajeConfirmacion({ nombre }, servicio, espCompleto, fecha, hora);
            nuevoEstado = { paso: 'inicio' };
          }
        } else {
          mensajeBase = `Ese especialista no está disponible para ${estado.servicio.nombre}. Déjame buscarte opciones...`;
          mensajeBase = await generarRecomendaciones(
            especialistas, estado.servicio, estado.fecha, estado.hora,
            { nombre: estado.nombre }, userPhone, nuevoEstado, true
          );
        }
      } else {
        mensajeBase = `¿Con cuál especialista te gustaría? Dime "primero", "segundo" o el nombre exacto.`;
        nuevoEstado = estado;
      }
    }
    
    // DEFAULT
    else {
      mensajeBase = mensajeNoEntiendo();
      nuevoEstado = { paso: 'inicio' };
    }

    // 4. HUMANIZAR Y RESPONDER
    const mensajeFinal = await humanizarMensaje(mensajeBase, { ...nuevoEstado, cliente: cliente?.nombre }, historial || []);
    
    await guardarEstado(userPhone, nuevoEstado);
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: mensajeFinal, created_at: new Date().toISOString() }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${mensajeFinal}</Message></Response>');

  } catch (err) {
    console.error('❌ Error crítico:', err);
    return res.status(200).send('<Response><Message>Disculpa, tuve un problema técnico. ¿Me repites? 🙏</Message></Response>');
  }
}

// ============ FUNCIÓN AUXILIAR ============

async function generarRecomendaciones(especialistas, servicio, fecha, hora, cliente, telefono, estadoRef, forzarNuevo = false) {
  const citasOcupadas = await obtenerCitasOcupadas(fecha);
  
  const validos = especialistas.filter(esp => puedeHacerServicio(esp, servicio.nombre));
  if (validos.length === 0) {
    estadoRef.paso = 'inicio';
    return mensajeNoEspecialistas(servicio.nombre);
  }
  
  const conInfo = validos.map(esp => {
    const citasHoy = citasOcupadas.filter(c => c.especialista === esp.nombre).length;
    
    const [h, m] = hora.split(':').map(Number);
    const inicio = h * 60 + m;
    const fin = inicio + (servicio.duracion || 60);
    
    let disponible = true;
    for (const cita of citasOcupadas) {
      if (cita.especialista !== esp.nombre) continue;
      const [hc, mc] = cita.hora.split(':').map(Number);
      const inicioC = hc * 60 + mc;
      const finC = inicioC + (cita.duracion || 60);
      if (inicio < finC && fin > inicioC) { disponible = false; break; }
    }
    
    let alternativas = [];
    if (!disponible) {
      for (let min = 9*60; min <= 18*60 - (servicio.duracion || 60); min += 30) {
        const hAlt = Math.floor(min/60), mAlt = min%60;
        const horaAlt = `${String(hAlt).padStart(2,'0')}:${String(mAlt).padStart(2,'0')}`;
        let libre = true;
        for (const cita of citasOcupadas) {
          if (cita.especialista !== esp.nombre) continue;
          const [hc, mc] = cita.hora.split(':').map(Number);
          const inicioC = hc * 60 + mc;
          const finC = inicioC + (cita.duracion || 60);
          if (min < finC && (min + (servicio.duracion || 60)) > inicioC) { libre = false; break; }
        }
        if (libre) alternativas.push(horaAlt);
        if (alternativas.length >= 3) break;
      }
    }
    
    return {
      ...esp,
      descripcion: generarDescripcionPersuasiva(esp, servicio.nombre),
      citasHoy,
      disponible,
      alternativas
    };
  }).sort((a, b) => {
    if (a.disponible && !b.disponible) return -1;
    if (!a.disponible && b.disponible) return 1;
    return a.citasHoy - b.citasHoy;
  });
  
  const top2 = conInfo.slice(0, 2);
  
  estadoRef.paso = 'esperando_especialista';
  estadoRef.servicio = servicio;
  estadoRef.fecha = fecha;
  estadoRef.hora = hora;
  estadoRef.especialistasRecomendados = top2.map(e => ({ id: e.id, nombre: e.nombre }));
  estadoRef.nombre = cliente?.nombre;
  
  return mensajeRecomendacion(top2, servicio, fecha, hora, cliente);
}
