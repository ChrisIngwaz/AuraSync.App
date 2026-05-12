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

// ═══════════════════════════════════════════════════════════════
// UTILIDADES DE FECHA/HORA
// ═══════════════════════════════════════════════════════════════

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
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

function formatearHora(horaStr) {
  if (!horaStr) return '';
  const [h, m] = horaStr.split(':').map(Number);
  const periodo = h >= 12 ? 'p.m.' : 'a.m.';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

function parsearHora(texto) {
  // Extrae HH:MM de textos como "4:00 p.m.", "16:00", "a las 4"
  const match = texto.match(/(?:(?:a\s+las|las)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const periodo = match[3]?.toLowerCase();
  if (periodo?.includes('p') && h < 12) h += 12;
  if (periodo?.includes('a') && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parsearFechaRelativa(texto, hoy, manana, pasado) {
  const t = texto.toLowerCase();
  if (t.includes('pasado mañana')) return pasado;
  if (t.includes('mañana')) return manana;
  if (t.includes('hoy')) return hoy;
  // Buscar formato dd/mm/aaaa o dd-mm-aaaa
  const match = texto.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (match) {
    return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
  }
  return null;
}

function validarFechaNacimiento(fechaStr) {
  if (!fechaStr) return null;
  const partes = fechaStr.split(/[\/-]/);
  if (partes.length !== 3) return null;
  const dia = parseInt(partes[0], 10);
  const mes = parseInt(partes[1], 10);
  const anio = parseInt(partes[2], 10);
  if (isNaN(dia) || isNaN(mes) || isNaN(anio)) return null;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 1900 || anio > new Date().getFullYear()) return null;
  const diasPorMes = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if ((anio % 4 === 0 && anio % 100 !== 0) || (anio % 400 === 0)) diasPorMes[1] = 29;
  if (dia > diasPorMes[mes - 1]) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE
// ═══════════════════════════════════════════════════════════════

async function buscarCitaAirtable({ supabaseId, telefono, fecha, hora, especialista }) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    if (supabaseId) {
      const filter1 = encodeURIComponent(`{ID_Supabase} = '${supabaseId}'`);
      const res1 = await axios.get(`${url}?filterByFormula=${filter1}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res1.data.records?.length) return { ok: true, record: res1.data.records[0] };
    }
    if (telefono && fecha && hora) {
      const condiciones = [`{Teléfono} = '${telefono}'`, `IS_SAME({Fecha}, '${fecha}', 'days')`, `{Hora} = '${hora}'`];
      if (especialista) condiciones.push(`{Especialista} = '${especialista}'`);
      const filter2 = encodeURIComponent(`AND(${condiciones.join(', ')})`);
      const res2 = await axios.get(`${url}?filterByFormula=${filter2}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res2.data.records?.length) return { ok: true, record: res2.data.records[0] };
    }
    if (telefono && fecha) {
      const filter3 = encodeURIComponent(`AND({Teléfono} = '${telefono}', IS_SAME({Fecha}, '${fecha}', 'days'))`);
      const res3 = await axios.get(`${url}?filterByFormula=${filter3}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res3.data.records?.length) return { ok: true, record: res3.data.records[0] };
    }
    return { ok: false, error: 'No encontrado' };
  } catch (error) {
    console.error('Error buscando en Airtable:', error.response?.data || error.message);
    return { ok: false, error: error.message };
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
          "ID_Supabase": datos.supabase_id || null,
          "Email de cliente": datos.email || null,
          "Notas de la cita": datos.notas || null,
          "Observaciones de confirmación": datos.observaciones || null
        }
      }]
    };
    const response = await axios.post(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return { ok: true, recordId: response.data.records?.[0]?.id };
  } catch (error) {
    console.error('Error Airtable Create:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

async function actualizarCitaAirtable(supabaseId, nuevosDatos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({
      supabaseId, telefono: nuevosDatos.telefono, fecha: nuevosDatos.fechaAnterior,
      hora: nuevosDatos.horaAnterior, especialista: nuevosDatos.especialistaAnterior
    });
    if (!busqueda.ok) return { ok: false, error: 'Cita no encontrada en Airtable' };
    const recordId = busqueda.record.id;
    const [h, min] = nuevosDatos.hora.split(':').map(Number);
    const [anio, mes, dia] = nuevosDatos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    const payload = {
      records: [{
        id: recordId,
        fields: {
          "Fecha": fechaUTC, "Hora": nuevosDatos.hora,
          "Especialista": nuevosDatos.especialista, "Estado": "Confirmada",
          "Observaciones de confirmación": nuevosDatos.observaciones || "Cita reagendada"
        }
      }]
    };
    if (supabaseId && !busqueda.record.fields.ID_Supabase) {
      payload.records[0].fields["ID_Supabase"] = supabaseId;
    }
    await axios.patch(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return { ok: true, recordId };
  } catch (error) {
    console.error('Error Airtable Update:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

async function cancelarCitaAirtable(supabaseId, motivo, datosFallback) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({
      supabaseId, telefono: datosFallback?.telefono, fecha: datosFallback?.fecha,
      hora: datosFallback?.hora, especialista: datosFallback?.especialista
    });
    if (!busqueda.ok) return { ok: false, error: 'Cita no encontrada en Airtable' };
    await axios.patch(url, {
      records: [{
        id: busqueda.record.id,
        fields: {
          "Estado": "Cancelada",
          "Observaciones de confirmación": motivo ? `Cancelada: ${motivo}` : "Cancelada por cliente"
        }
      }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { ok: true, recordId: busqueda.record.id };
  } catch (error) {
    console.error('Error Airtable Cancel:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// MOTOR DE DISPONIBILIDAD REAL (La pieza clave)
// ═══════════════════════════════════════════════════════════════

async function obtenerCitasDelDia(fecha, excluirCitaId = null) {
  try {
    const inicioDia = `${fecha}T00:00:00`;
    const finDia = `${fecha}T23:59:59`;
    let query = supabase
      .from('citas')
      .select('id, fecha_hora, especialista_id, duracion_aux, servicio_aux, estado, nombre_cliente_aux, cliente_id')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);
    if (excluirCitaId) query = query.neq('id', excluirCitaId);
    const { data: citasSupabase, error: supaError } = await query;
    if (supaError) { console.error('Error Supabase citas:', supaError); return []; }
    const { data: especialistasData } = await supabase.from('especialistas').select('id, nombre');
    const mapaEspecialistas = {};
    (especialistasData || []).forEach(e => { mapaEspecialistas[e.id] = e.nombre; });
    return (citasSupabase || []).map(c => {
      const hora = c.fecha_hora ? c.fecha_hora.substring(11, 16) : null;
      return {
        id: c.id, hora, duracion: c.duracion_aux || 60,
        especialista: mapaEspecialistas[c.especialista_id] || 'Asignar',
        especialista_id: c.especialista_id, servicio: c.servicio_aux,
        idSupabase: c.id, cliente_id: c.cliente_id
      };
    }).filter(c => c.hora);
  } catch (error) {
    console.error('Error obteniendo citas del día:', error.message);
    return [];
  }
}

async function obtenerCargaEspecialistas(fechaInicio, fechaFin, especialistasIds) {
  // Cuenta cuántas citas tiene cada especialista en un rango de fechas para rotación equitativa
  try {
    const { data: citas } = await supabase
      .from('citas')
      .select('especialista_id, estado')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', `${fechaInicio}T00:00:00`)
      .lte('fecha_hora', `${fechaFin}T23:59:59`)
      .in('especialista_id', especialistasIds);
    const carga = {};
    especialistasIds.forEach(id => carga[id] = 0);
    (citas || []).forEach(c => { if (carga[c.especialista_id] !== undefined) carga[c.especialista_id]++; });
    return carga;
  } catch (e) {
    console.error('Error carga especialistas:', e);
    return {};
  }
}

function hayConflictoHorario(inicioNuevo, finNuevo, citasExistentes, especialistaNombre = null) {
  for (const cita of citasExistentes) {
    if (!cita.hora) continue;
    const [he, me] = cita.hora.split(':').map(Number);
    const inicioExistente = he * 60 + me;
    const finExistente = inicioExistente + (cita.duracion || 60);
    if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
      if (!especialistaNombre || cita.especialista === especialistaNombre) {
        return { conflicto: true, cita };
      }
    }
  }
  return { conflicto: false };
}

async function verificarDisponibilidad(fecha, hora, especialistaSolicitado, duracionMinutos, excluirCitaId = null) {
  const citas = await obtenerCitasDelDia(fecha, excluirCitaId);
  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracionMinutos || 60);

  if (inicioNuevo < 540) {
    return { ok: false, mensaje: "Nuestro horario comienza a las 9:00 a.m. 🌅" };
  }
  if (finNuevo > 1080) {
    return { ok: false, mensaje: "Ese horario excede nuestra jornada (hasta las 6:00 p.m.). ¿Te funciona más temprano?" };
  }

  const conflicto = hayConflictoHorario(inicioNuevo, finNuevo, citas, especialistaSolicitado);
  if (conflicto.conflicto) {
    const c = conflicto.cita;
    return {
      ok: false,
      mensaje: `Ups, ${c.especialista || 'ese horario'} ya está ocupado${c.servicio ? ` con un ${c.servicio}` : ''}. 😔`,
      conflictoCon: c
    };
  }
  return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
}

async function buscarAlternativa(fecha, horaSolicitada, especialistaSolicitado, duracion, excluirCitaId = null) {
  const citas = await obtenerCitasDelDia(fecha, excluirCitaId);
  const [h, m] = horaSolicitada.split(':').map(Number);
  let horaPropuesta = h * 60 + m;
  while (horaPropuesta <= 1080 - duracion) {
    const conflicto = hayConflictoHorario(horaPropuesta, horaPropuesta + duracion, citas, especialistaSolicitado);
    if (!conflicto.conflicto) {
      const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
      return { mensaje: `¿Qué tal a las ${formatearHora(horaStr)}?`, hora: horaStr };
    }
    horaPropuesta += 15;
  }
  return { mensaje: "Ese día ya no tenemos cupos disponibles. ¿Te parece otro día? 📅" };
}

async function obtenerEspecialistasDisponibles(fecha, hora, duracion, servicioCategoria = null) {
  // Devuelve especialistas ordenados por carga (menos citas = primero) para rotación equitativa
  const { data: todosEspecialistas } = await supabase
    .from('especialistas')
    .select('id, nombre, rol, expertise, local_id, activo')
    .eq('activo', true);

  if (!todosEspecialistas?.length) return [];

  const citas = await obtenerCitasDelDia(fecha);
  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracion || 60);

  // Filtrar solo los que no tienen conflicto a esa hora
  const disponibles = todosEspecialistas.filter(esp => {
    const conflicto = hayConflictoHorario(inicioNuevo, finNuevo, citas, esp.nombre);
    return !conflicto.conflicto;
  });

  if (!disponibles.length) return [];

  // Obtener carga de los últimos 30 días para rotación equitativa
  const hoy = getFechaEcuador(0);
  const hace30Dias = getFechaEcuador(-30);
  const carga = await obtenerCargaEspecialistas(hace30Dias, hoy, disponibles.map(e => e.id));

  // Ordenar por carga ascendente (menos citas primero)
  disponibles.sort((a, b) => (carga[a.id] || 0) - (carga[b.id] || 0));

  return disponibles;
}

// ═══════════════════════════════════════════════════════════════
// MÁQUINA DE ESTADOS (El corazón de la corrección)
// ═══════════════════════════════════════════════════════════════

/*
ESTADOS:
- 'inicio': Cliente nuevo o sin contexto
- 'esperando_servicio': Ya saludó, falta saber qué servicio quiere
- 'esperando_especialista': Servicio definido, mostrar opciones de especialistas
- 'esperando_confirmacion': Especialista y hora propuestos, esperando "sí"
- 'esperando_fecha_hora': Falta fecha u hora
- 'reagendar_listar': Mostrar citas para reagendar
- 'reagendar_esperando_nueva': Cita identificada, esperando nueva fecha/hora
- 'cancelar_listar': Mostrar citas para cancelar
- 'cancelar_confirmar': Esperando confirmación de cancelación
*/

async function detectarEstado(historial, cliente, textoUsuario, hoy, manana, pasado) {
  const t = textoUsuario.toLowerCase().trim();
  const ultimoAssistant = historial.filter(m => m.rol === 'assistant').pop()?.contenido?.toLowerCase() || '';
  const ultimoUser = historial.filter(m => m.rol === 'user').pop()?.contenido?.toLowerCase() || '';

  // Detectar intención explícita
  const intencionReagendar = /reagendar|mover|cambiar|modificar/.test(t);
  const intencionCancelar = /cancelar|anular|eliminar/.test(t);
  const intencionAgendar = /agendar|reservar|pedir|quiero/.test(t) && !intencionReagendar && !intencionCancelar;

  // Si es nuevo y no tiene nombre, siempre inicio
  if (!cliente?.nombre) return { estado: 'inicio', intencion: 'registro' };

  // Detectar si el último mensaje del bot estaba pidiendo confirmación
  if (ultimoAssistant.includes('¿te lo agendo') || ultimoAssistant.includes('¿confirmamos') || ultimoAssistant.includes('¿te parece')) {
    if (/^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va|bueno/.test(t)) {
      return { estado: 'confirmar_cita', intencion: 'agendar' };
    }
    if (/no|otro|diferente|cambiar|más tarde|más temprano/.test(t)) {
      return { estado: 'esperando_fecha_hora', intencion: 'agendar' };
    }
  }

  // Si el último mensaje mostró especialistas
  if (ultimoAssistant.includes('¿con quién te gustaría') || ultimoAssistant.includes('te puedo ofrecer a')) {
    // El usuario está eligiendo especialista
    const mencionaEspecialista = /elena|anita|carlos|maria|laura|sofia|juan|pedro/.test(t);
    if (mencionaEspecialista || t.length < 20) {
      return { estado: 'esperando_fecha_hora', intencion: 'agendar' };
    }
  }

  // Si el último mensaje pedía fecha/hora
  if (ultimoAssistant.includes('¿qué día') || ultimoAssistant.includes('¿qué hora') || ultimoAssistant.includes('tengo disponible')) {
    return { estado: 'procesar_fecha_hora', intencion: 'agendar' };
  }

  // Reagendar
  if (intencionReagendar) {
    return { estado: 'reagendar_listar', intencion: 'reagendar' };
  }

  // Cancelar
  if (intencionCancelar) {
    return { estado: 'cancelar_listar', intencion: 'cancelar' };
  }

  // Si ya dijo un servicio en este mensaje
  const mencionaServicio = /manicura|pedicura|corte|tinte|facial|masaje|depilación|pestañas|cejas|uñas|tratamiento/.test(t);
  if (mencionaServicio) {
    return { estado: 'esperando_especialista', intencion: 'agendar' };
  }

  // Si no hay contexto claro, asumir que quiere agendar
  return { estado: 'esperando_servicio', intencion: 'agendar' };
}

// ═══════════════════════════════════════════════════════════════
// GENERADOR DE RESPUESTAS (LLM solo para texto, no para lógica)
// ═══════════════════════════════════════════════════════════════

async function generarRespuestaTexto(contexto, mensajesPrevios) {
  const systemPrompt = `Eres Aura, asistente de AuraSync. Coordinadora humana, cálida, elegante y eficiente. NUNCA robótica.

REGLAS ABSOLUTAS:
1. Usa EXACTAMENTE los datos que te paso en el contexto. NUNCA inventes especialistas, servicios, precios ni horarios.
2. Mensajes cortos, como WhatsApp real. Máximo 2-3 oraciones.
3. Un solo paso por mensaje. NUNCA combines saludo + especialista + horario en un solo mensaje.
4. Usa emojis con moderación: 🌸 ✨ 💫
5. Si propones especialistas, SIEMPRE menciona su expertise real.
6. Si confirmas una cita, incluye todos los detalles: servicio, fecha, hora, especialista, precio.
7. NUNCA digas que un especialista no está disponible si el contexto dice que sí lo está.
8. NUNCA pidas datos que ya tengamos del cliente.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...mensajesPrevios.slice(-6).map(m => ({ role: m.rol === 'assistant' ? 'assistant' : 'user', content: m.contenido })),
    { role: "user", content: `CONTEXTO DEL SISTEMA (usar estos datos exactos):\n${JSON.stringify(contexto, null, 2)}\n\nGenera la respuesta de Aura según el estado actual y los datos disponibles.` }
  ];

  const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: "gpt-4o-mini", // Más rápido y económico para texto
    messages: messages,
    temperature: 0.4,
    max_tokens: 250
  }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` } });

  return aiRes.data.choices[0].message.content.trim();
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL REESCRITO
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    let textoUsuario = Body || "";

    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es",
          { url: MediaUrl0 },
          { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) { console.error('Error Deepgram:', error.message); }
    }

    // ── Cargar datos ──
    let { data: cliente } = await supabase
      .from('clientes')
      .select('id, telefono, nombre, apellido, email, fecha_nacimiento, especialista_pref_id, notas_bienestar')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre, rol, expertise, local_id, activo').eq('activo', true);
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion, categoria, descripcion_voda');

    const esNuevo = !cliente || !cliente.nombre || cliente.nombre.trim() === '';

    const { data: mensajesRaw } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(20);
    const historial = (mensajesRaw || []).reverse();

    const hoy = getFechaEcuador(0);
    const manana = getFechaEcuador(1);
    const pasadoManana = getFechaEcuador(2);

    let respuesta = '';
    let accionBackend = 'none';
    let datosCita = null;

    // ═══════════════════════════════════════════════════════
    // FLUJO: REGISTRO DE CLIENTE NUEVO
    // ═══════════════════════════════════════════════════════
    if (esNuevo) {
      const yaPidioDatos = historial.some(m => m.rol === 'assistant' && /nombre.*apellido.*fecha/i.test(m.contenido));

      if (yaPidioDatos) {
        // Intentar extraer datos del mensaje actual
        const nombreMatch = textoUsuario.match(/(?:me llamo|soy|mi nombre es)?\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)(?:\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+))?/i);
        const fechaMatch = textoUsuario.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);

        if (nombreMatch && fechaMatch) {
          const nombre = nombreMatch[1]?.trim();
          const apellido = nombreMatch[2]?.trim() || '';
          const fechaNac = validarFechaNacimiento(`${fechaMatch[1]}/${fechaMatch[2]}/${fechaMatch[3]}`);

          if (nombre && fechaNac) {
            const { data: nuevoCliente, error: insertError } = await supabase
              .from('clientes')
              .insert({ telefono: userPhone, nombre, apellido, fecha_nacimiento: fechaNac })
              .select().single();

            if (insertError && insertError.code === '23505') {
              const { data: updated } = await supabase.from('clientes')
                .update({ nombre, apellido, fecha_nacimiento: fechaNac })
                .eq('telefono', userPhone).select().single();
              cliente = updated;
            } else {
              cliente = nuevoCliente;
            }

            respuesta = `¡Listo, ${nombre}! 🌸 Ya estás registrado/a en AuraSync. ¿En qué puedo ayudarte hoy?`;
            accionBackend = 'registrar';
          } else {
            respuesta = "Necesito que me compartas tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa) para registrarte. 🌸";
          }
        } else {
          respuesta = "Para completar tu registro necesito: tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa). ¿Me los compartes? 🌸";
        }
      } else {
        respuesta = `¡Hola! 🌸 Soy Aura de AuraSync, encantada de conocerte. Para registrarte en nuestro sistema necesito: tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa). ¿Me los compartes?`;
      }
    } else {
      // ═══════════════════════════════════════════════════════
      // FLUJO PRINCIPAL: MÁQUINA DE ESTADOS
      // ═══════════════════════════════════════════════════════
      const estadoDetectado = await detectarEstado(historial, cliente, textoUsuario, hoy, manana, pasadoManana);

      console.log('🎯 Estado detectado:', estadoDetectado.estado, '| Intención:', estadoDetectado.intencion);

      // ── REAGENDAR ──
      if (estadoDetectado.intencion === 'reagendar' || estadoDetectado.estado === 'reagendar_listar') {
        const { data: citasConfirmadas } = await supabase
          .from('citas')
          .select('id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
          .eq('cliente_id', cliente.id)
          .eq('estado', 'Confirmada')
          .order('fecha_hora', { ascending: true })
          .limit(10);

        if (!citasConfirmadas?.length) {
          respuesta = "No encontré citas activas a tu nombre. ¿Quieres que agende una nueva? 💫";
        } else {
          const espMap = {};
          (especialistas || []).forEach(e => espMap[e.id] = e.nombre);

          // Si solo tiene una cita, preguntar nueva fecha/hora directamente
          if (citasConfirmadas.length === 1) {
            const c = citasConfirmadas[0];
            const fecha = c.fecha_hora.split('T')[0];
            const hora = c.fecha_hora.substring(11, 16);
            respuesta = `Veo que tienes una cita de *${c.servicio_aux}* el *${formatearFecha(fecha)}* a las *${formatearHora(hora)}* con *${espMap[c.especialista_id] || 'Asignar'}*.\n\n¿Para qué fecha y hora la quieres mover? 📅`;
            // Guardar en metadata temporal que estamos reagendando esta cita específica
            await supabase.from('conversaciones').insert([
              { telefono: userPhone, rol: 'system', contenido: `REAGENDAR_CITA_ID:${c.id}` }
            ]);
          } else {
            const lista = citasConfirmadas.map((c, i) => {
              const f = c.fecha_hora.split('T')[0];
              const h = c.fecha_hora.substring(11, 16);
              return `${i + 1}. *${c.servicio_aux}* el ${formatearFecha(f)} a las ${formatearHora(h)}`;
            }).join('\n');
            respuesta = `Tienes ${citasConfirmadas.length} citas confirmadas:\n${lista}\n\n¿Cuál quieres mover? Responde con el número. 💫`;
          }
        }
        accionBackend = 'reagendar';
      }

      // ── CANCELAR ──
      else if (estadoDetectado.intencion === 'cancelar' || estadoDetectado.estado === 'cancelar_listar') {
        const { data: citasConfirmadas } = await supabase
          .from('citas')
          .select('id, servicio_aux, fecha_hora, especialista_id')
          .eq('cliente_id', cliente.id)
          .eq('estado', 'Confirmada')
          .order('fecha_hora', { ascending: true })
          .limit(10);

        if (!citasConfirmadas?.length) {
          respuesta = "No encontré citas activas a tu nombre para cancelar. 🌸";
        } else {
          const espMap = {};
          (especialistas || []).forEach(e => espMap[e.id] = e.nombre);
          if (citasConfirmadas.length === 1) {
            const c = citasConfirmadas[0];
            const f = c.fecha_hora.split('T')[0];
            const h = c.fecha_hora.substring(11, 16);
            respuesta = `¿Quieres cancelar tu cita de *${c.servicio_aux}* del *${formatearFecha(f)}* a las *${formatearHora(h)}*? Responde *sí* para confirmar. 🌸`;
            await supabase.from('conversaciones').insert([
              { telefono: userPhone, rol: 'system', contenido: `CANCELAR_CITA_ID:${c.id}` }
            ]);
          } else {
            const lista = citasConfirmadas.map((c, i) => {
              const f = c.fecha_hora.split('T')[0];
              const h = c.fecha_hora.substring(11, 16);
              return `${i + 1}. *${c.servicio_aux}* el ${formatearFecha(f)} a las ${formatearHora(h)}`;
            }).join('\n');
            respuesta = `¿Cuál cita quieres cancelar?\n${lista}\n\nResponde con el número. 🌸`;
          }
        }
        accionBackend = 'cancelar';
      }

      // ── CONFIRMAR CITA (después de "¿Te lo agendo?") ──
      else if (estadoDetectado.estado === 'confirmar_cita') {
        // Recuperar los datos de la cita propuesta del historial
        const propuestaMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('PROPUESTA_CITA:'));
        const ultimaPropuesta = propuestaMatch.pop()?.contenido;

        if (!ultimaPropuesta) {
          respuesta = "Disculpa, no recordé los detalles de la cita que estábamos agendando. ¿Me los repites? 🌸";
        } else {
          const datosPropuesta = JSON.parse(ultimaPropuesta.replace('PROPUESTA_CITA:', ''));

          // VERIFICAR DISPONIBILIDAD UNA VEZ MÁS antes de insertar
          const disponible = await verificarDisponibilidad(
            datosPropuesta.fecha, datosPropuesta.hora, datosPropuesta.especialista, datosPropuesta.duracion
          );

          if (!disponible.ok) {
            const alternativa = await buscarAlternativa(
              datosPropuesta.fecha, datosPropuesta.hora, datosPropuesta.especialista, datosPropuesta.duracion
            );
            respuesta = `${disponible.mensaje} ${alternativa.mensaje}`;

            // Actualizar propuesta con nueva hora si hay alternativa
            if (alternativa.hora) {
              datosPropuesta.hora = alternativa.hora;
              await supabase.from('conversaciones').insert([
                { telefono: userPhone, rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify(datosPropuesta)}` }
              ]);
            }
          } else {
            // INSERTAR EN SUPABASE
            const { data: citaSupabase, error: insertError } = await supabase
              .from('citas')
              .insert({
                cliente_id: cliente.id,
                servicio_id: datosPropuesta.servicio_id,
                especialista_id: datosPropuesta.especialista_id,
                fecha_hora: `${datosPropuesta.fecha}T${datosPropuesta.hora}:00-05:00`,
                estado: 'Confirmada',
                nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
                servicio_aux: datosPropuesta.servicio,
                duracion_aux: datosPropuesta.duracion
              })
              .select().single();

            if (insertError) {
              console.error('❌ Error insert Supabase:', insertError);
              respuesta = "Ups, tuve un problema guardando tu cita. ¿Me das un momento? 🙏";
            } else {
              // SINCRONIZAR AIRTABLE
              const airtableRes = await crearCitaAirtable({
                telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
                fecha: datosPropuesta.fecha, hora: datosPropuesta.hora,
                servicio: datosPropuesta.servicio, especialista: datosPropuesta.especialista,
                precio: datosPropuesta.precio, duracion: datosPropuesta.duracion,
                supabase_id: citaSupabase.id, email: cliente.email || null,
                notas: cliente.notas_bienestar || null, observaciones: 'Agendada por AuraSync'
              });

              if (airtableRes.ok) {
                respuesta = `✨ ¡Listo! Tu cita para *${datosPropuesta.servicio}* está confirmada:\n📅 ${formatearFecha(datosPropuesta.fecha)}\n⏰ ${formatearHora(datosPropuesta.hora)}\n💇‍♀️ Con ${datosPropuesta.especialista}\n💰 $${datosPropuesta.precio}\n\nTe esperamos con mucho cariño. 🌸`;
              } else {
                respuesta = `✅ Tu cita está guardada. Te confirmo:\n📅 ${formatearFecha(datosPropuesta.fecha)} a las ${formatearHora(datosPropuesta.hora)}\n💇‍♀️ ${datosPropuesta.servicio} con ${datosPropuesta.especialista}`;
              }
              accionBackend = 'agendar';
            }
          }
        }
      }

      // ── PROCESAR FECHA/HORA (después de elegir especialista o decir hora) ──
      else if (estadoDetectado.estado === 'procesar_fecha_hora' || estadoDetectado.estado === 'esperando_fecha_hora') {
        // Extraer fecha y hora del mensaje
        let fecha = parsearFechaRelativa(textoUsuario, hoy, manana, pasadoManana);
        let hora = parsearHora(textoUsuario);

        // Si no extrajo fecha, asumir mañana como default (o recuperar del contexto)
        if (!fecha) {
          const ultimaFechaMencionada = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('FECHA_PROPUESTA:')).pop()?.contenido;
          if (ultimaFechaMencionada) fecha = ultimaFechaMencionada.replace('FECHA_PROPUESTA:', '');
          else fecha = manana;
        }

        // Si no extrajo hora, preguntar
        if (!hora) {
          respuesta = `¿A qué hora te funciona para el ${formatearFecha(fecha)}? Te sugiero entre 9:00 a.m. y 6:00 p.m. 🌸`;
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` }
          ]);
        } else {
          // Detectar servicio del contexto
          const servicioMencionado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('SERVICIO_SELECCIONADO:')).pop()?.contenido?.replace('SERVICIO_SELECCIONADO:', '');
          const servicioData = servicios?.find(s => s.nombre.toLowerCase() === (servicioMencionado || '').toLowerCase()) || servicios?.[0];

          // Detectar especialista del contexto o del mensaje
          let especialistaNombre = null;
          let especialistaId = null;

          // Buscar en el mensaje actual
          for (const esp of (especialistas || [])) {
            if (textoUsuario.toLowerCase().includes(esp.nombre.toLowerCase())) {
              especialistaNombre = esp.nombre;
              especialistaId = esp.id;
              break;
            }
          }

          // Si no encontró en este mensaje, buscar en el historial de propuestas
          if (!especialistaNombre) {
            const ultimaEsp = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('ESPECIALISTA_PROPUESTO:')).pop()?.contenido?.replace('ESPECIALISTA_PROPUESTO:', '');
            if (ultimaEsp) {
              const espData = especialistas?.find(e => e.nombre === ultimaEsp);
              if (espData) { especialistaNombre = espData.nombre; especialistaId = espData.id; }
            }
          }

          // Si aún no hay especialista, obtener disponibles y sugerir
          if (!especialistaNombre) {
            const disponibles = await obtenerEspecialistasDisponibles(fecha, hora, servicioData?.duracion || 60);
            if (disponibles.length === 0) {
              const alternativa = await buscarAlternativa(fecha, hora, null, servicioData?.duracion || 60);
              respuesta = `Ese horario no está disponible. ${alternativa.mensaje}`;
            } else {
              // Mostrar top 2-3 especialistas disponibles (rotación equitativa ya aplicada en el orden)
              const topEspecialistas = disponibles.slice(0, 3);
              const lista = topEspecialistas.map(e => `• *${e.nombre}* — ${e.expertise || e.rol || 'Especialista'}`).join('\n');
              respuesta = `Para ${servicioData?.nombre || 'tu servicio'} a las ${formatearHora(hora)} del ${formatearFecha(fecha)} tengo disponible a:\n${lista}\n\n¿Con quién te gustaría? ✨`;

              // Guardar contexto
              await supabase.from('conversaciones').insert([
                { telefono: userPhone, rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData?.nombre}` },
                { telefono: userPhone, rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` },
                { telefono: userPhone, rol: 'system', contenido: `HORA_PROPUESTA:${hora}` }
              ]);
            }
          } else {
            // Ya tenemos especialista, verificar disponibilidad
            const disponible = await verificarDisponibilidad(fecha, hora, especialistaNombre, servicioData?.duracion || 60);

            if (!disponible.ok) {
              const alternativa = await buscarAlternativa(fecha, hora, especialistaNombre, servicioData?.duracion || 60);
              respuesta = `${disponible.mensaje} ${alternativa.mensaje}`;
              if (alternativa.hora) {
                // Actualizar propuesta con nueva hora
                await supabase.from('conversaciones').insert([
                  { telefono: userPhone, rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify({
                    fecha, hora: alternativa.hora, especialista: especialistaNombre,
                    especialista_id: especialistaId, servicio: servicioData?.nombre,
                    servicio_id: servicioData?.id, precio: servicioData?.precio,
                    duracion: servicioData?.duracion
                  })}` }
                ]);
                respuesta += `\n\n¿Te lo agendo a las ${formatearHora(alternativa.hora)}? 🌸`;
              }
            } else {
              // Todo disponible, proponer confirmación
              respuesta = `Perfecto, te confirmo *${servicioData?.nombre}* con *${especialistaNombre}* el *${formatearFecha(fecha)}* a las *${formatearHora(hora)}*.\n\n¿Te lo agendo? ✨`;

              await supabase.from('conversaciones').insert([
                { telefono: userPhone, rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify({
                  fecha, hora, especialista: especialistaNombre,
                  especialista_id: especialistaId, servicio: servicioData?.nombre,
                  servicio_id: servicioData?.id, precio: servicioData?.precio,
                  duracion: servicioData?.duracion
                })}` }
              ]);
            }
          }
        }
      }

      // ── MOSTRAR ESPECIALISTAS (después de saber servicio) ──
      else if (estadoDetectado.estado === 'esperando_especialista') {
        // Detectar servicio del mensaje
        let servicioData = null;
        for (const s of (servicios || [])) {
          if (textoUsuario.toLowerCase().includes(s.nombre.toLowerCase()) || 
              textoUsuario.toLowerCase().includes(s.categoria?.toLowerCase() || '')) {
            servicioData = s;
            break;
          }
        }

        // Si no detectó servicio en este mensaje, buscar en historial
        if (!servicioData) {
          const servicioGuardado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('SERVICIO_SELECCIONADO:')).pop()?.contenido?.replace('SERVICIO_SELECCIONADO:', '');
          servicioData = servicios?.find(s => s.nombre === servicioGuardado);
        }

        if (!servicioData) {
          // Listar servicios disponibles
          const listaServicios = (servicios || []).map(s => `• *${s.nombre}* — $${s.precio}, ${s.duracion} min`).join('\n');
          respuesta = `Estos son nuestros servicios disponibles:\n${listaServicios}\n\n¿Cuál te gustaría agendar? 🌸`;
        } else {
          // Guardar servicio seleccionado
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData.nombre}` }
          ]);

          // Buscar especialistas disponibles para mañana a las 10:00 como default (o preguntar hora primero)
          // Mejor: preguntar fecha/hora primero, luego mostrar especialistas disponibles
          respuesta = `Excelente elección. *${servicioData.nombre}* — $${servicioData.precio}, ${servicioData.duracion} minutos.\n\n¿Para qué día y hora te funciona? 📅`;
        }
      }

      // ── ESTADO INICIAL O ESPERANDO SERVICIO ──
      else {
        // Saludo + preguntar servicio
        respuesta = `¡Hola ${cliente.nombre}! 🌸 Soy Aura. ¿Qué servicio te gustaría agendar hoy?`;
        if (servicios?.length) {
          const populares = servicios.slice(0, 3).map(s => `*${s.nombre}* ($${s.precio})`).join(', ');
          respuesta += ` Tenemos ${populares}...`;
        }
      }
    }

    // ── Guardar conversación ──
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: respuesta }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error General:', err.message, err.stack);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problemita técnico. ¿Me das un segundito? 🌸</Message></Response>');
  }
}
