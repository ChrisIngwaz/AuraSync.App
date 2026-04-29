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
const HORA_APERTURA = 540;  // 9:00 en minutos
const HORA_CIERRE = 1080;   // 18:00 en minutos
const SLOT_MINUTOS = 15;    // granularidad de slots

// ═══════════════════════════════════════════════════════════════
// UTILIDADES DE FECHA/HORA
// ═══════════════════════════════════════════════════════════════

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const parts = new Intl.DateTimeFormat('en-US', opciones).formatToParts(ahora);
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026');
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '1');
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '1');
  const fecha = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO || 'fecha por confirmar';
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
  const match = texto.match(/(?:(?:a\s+las|las)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const periodo = match[3]?.toLowerCase();
  if (periodo?.includes('p') && h < 12) h += 12;
  if (periodo?.includes('a') && h === 12) h = 0;
  // Sin periodo explícito: si hora < 8 asumimos PM (ej: "a las 4" = 16:00)
  if (!periodo && h >= 1 && h <= 7) h += 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parsearFechaRelativa(texto, hoy, manana, pasado) {
  const t = texto.toLowerCase();
  if (t.includes('pasado mañana')) return pasado;
  if (t.includes('mañana')) return manana;
  if (t.includes('hoy')) return hoy;
  const match = texto.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (match) return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
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
  if ((anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0) diasPorMes[1] = 29;
  if (dia > diasPorMes[mes - 1]) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function minutosAHora(minutos) {
  return `${Math.floor(minutos / 60).toString().padStart(2, '0')}:${(minutos % 60).toString().padStart(2, '0')}`;
}

function horaAMinutos(horaStr) {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

// ═══════════════════════════════════════════════════════════════
// CONTEXTO DE CONVERSACIÓN (extrae estado guardado en mensajes system)
// ═══════════════════════════════════════════════════════════════

function extraerContexto(historial) {
  const ctx = {};
  for (const m of historial) {
    if (m.rol !== 'system') continue;
    const c = m.contenido;
    if (c.startsWith('PROPUESTA_CITA:')) { try { ctx.propuestaCita = JSON.parse(c.slice(15)); } catch (_) {} }
    if (c.startsWith('SERVICIO_SELECCIONADO:')) ctx.servicioSeleccionado = c.slice(22);
    if (c.startsWith('FECHA_PROPUESTA:')) ctx.fechaPropuesta = c.slice(16);
    if (c.startsWith('HORA_PROPUESTA:')) ctx.horaPropuesta = c.slice(15);
    if (c.startsWith('ESPECIALISTA_PROPUESTO:')) ctx.especialistaPropuesto = c.slice(23);
    if (c.startsWith('REAGENDAR_CITA_ID:')) ctx.reagendarCitaId = c.slice(18);
    if (c.startsWith('CANCELAR_CITA_ID:')) ctx.cancelarCitaId = c.slice(17);
    if (c.startsWith('LISTA_ESPERA_NOTIF:')) { try { ctx.listaEsperaNotif = JSON.parse(c.slice(19)); } catch (_) {} }
  }
  return ctx;
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE
// ═══════════════════════════════════════════════════════════════

async function buscarCitaAirtable({ supabaseId, telefono, fecha, hora, especialista }) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const headers = { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` };

    if (supabaseId) {
      const f = encodeURIComponent(`{ID_Supabase} = '${supabaseId}'`);
      const r = await axios.get(`${url}?filterByFormula=${f}`, { headers });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    if (telefono && fecha && hora) {
      const conds = [`{Teléfono} = '${telefono}'`, `IS_SAME({Fecha}, '${fecha}', 'days')`, `{Hora} = '${hora}'`];
      if (especialista) conds.push(`{Especialista} = '${especialista}'`);
      const f = encodeURIComponent(`AND(${conds.join(', ')})`);
      const r = await axios.get(`${url}?filterByFormula=${f}`, { headers });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    if (telefono && fecha) {
      const f = encodeURIComponent(`AND({Teléfono} = '${telefono}', IS_SAME({Fecha}, '${fecha}', 'days'))`);
      const r = await axios.get(`${url}?filterByFormula=${f}`, { headers });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    return { ok: false, error: 'No encontrado' };
  } catch (err) {
    console.error('Error buscando en Airtable:', err.response?.data || err.message);
    return { ok: false, error: err.message };
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
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return { ok: true, recordId: response.data.records?.[0]?.id };
  } catch (err) {
    console.error('Error Airtable Create:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function actualizarCitaAirtable(supabaseId, nuevosDatos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({
      supabaseId,
      telefono: nuevosDatos.telefono,
      fecha: nuevosDatos.fechaAnterior,
      hora: nuevosDatos.horaAnterior,
      especialista: nuevosDatos.especialistaAnterior
    });
    if (!busqueda.ok) return { ok: false, error: 'Cita no encontrada en Airtable' };

    const [h, min] = nuevosDatos.hora.split(':').map(Number);
    const [anio, mes, dia] = nuevosDatos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    const payload = {
      records: [{
        id: busqueda.record.id,
        fields: {
          "Fecha": fechaUTC,
          "Hora": nuevosDatos.hora,
          "Especialista": nuevosDatos.especialista,
          "Estado": "Confirmada",
          "Observaciones de confirmación": nuevosDatos.observaciones || "Cita reagendada por cliente"
        }
      }]
    };
    if (supabaseId && !busqueda.record.fields.ID_Supabase) {
      payload.records[0].fields["ID_Supabase"] = supabaseId;
    }
    await axios.patch(url, payload, {
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return { ok: true, recordId: busqueda.record.id };
  } catch (err) {
    console.error('Error Airtable Update:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function cancelarCitaAirtable(supabaseId, motivo, datosFallback) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({
      supabaseId,
      telefono: datosFallback?.telefono,
      fecha: datosFallback?.fecha,
      hora: datosFallback?.hora,
      especialista: datosFallback?.especialista
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
    }, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { ok: true, recordId: busqueda.record.id };
  } catch (err) {
    console.error('Error Airtable Cancel:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// MOTOR DE DISPONIBILIDAD
// ═══════════════════════════════════════════════════════════════

async function obtenerCitasDelDia(fecha, excluirCitaId = null) {
  try {
    let query = supabase
      .from('citas')
      .select('id, fecha_hora, especialista_id, duracion_aux, servicio_aux, estado, nombre_cliente_aux, cliente_id')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', `${fecha}T00:00:00`)
      .lte('fecha_hora', `${fecha}T23:59:59`);
    if (excluirCitaId) query = query.neq('id', excluirCitaId);

    const { data: citasSupabase, error } = await query;
    if (error) { console.error('Error Supabase citas:', error); return []; }

    const { data: especialistasData } = await supabase.from('especialistas').select('id, nombre');
    const mapaEsp = {};
    (especialistasData || []).forEach(e => mapaEsp[e.id] = e.nombre);

    return (citasSupabase || []).map(c => ({
      id: c.id,
      hora: c.fecha_hora?.substring(11, 16) || null,
      duracion: c.duracion_aux || 60,
      especialista: mapaEsp[c.especialista_id] || 'Asignar',
      especialista_id: c.especialista_id,
      servicio: c.servicio_aux,
      cliente_id: c.cliente_id
    })).filter(c => c.hora);
  } catch (err) {
    console.error('Error obtenerCitasDelDia:', err.message);
    return [];
  }
}

async function obtenerCargaEspecialistas(fechaInicio, fechaFin, especialistasIds) {
  try {
    const { data: citas } = await supabase
      .from('citas')
      .select('especialista_id')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', `${fechaInicio}T00:00:00`)
      .lte('fecha_hora', `${fechaFin}T23:59:59`)
      .in('especialista_id', especialistasIds);

    const carga = {};
    especialistasIds.forEach(id => carga[id] = 0);
    (citas || []).forEach(c => { if (carga[c.especialista_id] !== undefined) carga[c.especialista_id]++; });
    return carga;
  } catch (err) {
    console.error('Error carga especialistas:', err);
    return {};
  }
}

function hayConflicto(inicioNuevo, finNuevo, citasExistentes, especialistaNombre = null) {
  for (const cita of citasExistentes) {
    if (!cita.hora) continue;
    if (especialistaNombre && cita.especialista !== especialistaNombre) continue;
    const inicioExistente = horaAMinutos(cita.hora);
    const finExistente = inicioExistente + (cita.duracion || 60);
    if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
      return { conflicto: true, cita };
    }
  }
  return { conflicto: false };
}

async function verificarDisponibilidad(fecha, hora, especialistaNombre, duracion, excluirCitaId = null) {
  const citas = await obtenerCitasDelDia(fecha, excluirCitaId);
  const inicioNuevo = horaAMinutos(hora);
  const finNuevo = inicioNuevo + (duracion || 60);

  if (inicioNuevo < HORA_APERTURA) return { ok: false, mensaje: "Nuestro horario comienza a las 9:00 a.m. 🌅" };
  if (finNuevo > HORA_CIERRE) return { ok: false, mensaje: "Ese horario supera nuestra jornada (hasta las 6:00 p.m.). ¿Te funciona más temprano?" };

  const resultado = hayConflicto(inicioNuevo, finNuevo, citas, especialistaNombre);
  if (resultado.conflicto) {
    const c = resultado.cita;
    return {
      ok: false,
      mensaje: `Ups, ese horario ya está ocupado con un ${c.servicio || 'servicio'} 😔`,
      conflictoCon: c
    };
  }
  return { ok: true };
}

async function buscarSlotsLibres(fecha, horaPreferida, duracion, especialistaNombre = null, excluirCitaId = null, maxResultados = 3) {
  const citas = await obtenerCitasDelDia(fecha, excluirCitaId);
  const slots = [];
  let inicio = horaAMinutos(horaPreferida);

  // Buscar hacia adelante primero, luego hacia atrás
  const candidatos = [];
  for (let t = inicio; t <= HORA_CIERRE - duracion; t += SLOT_MINUTOS) {
    candidatos.push({ minutos: t, distancia: t - inicio });
  }
  for (let t = inicio - SLOT_MINUTOS; t >= HORA_APERTURA; t -= SLOT_MINUTOS) {
    candidatos.push({ minutos: t, distancia: inicio - t });
  }
  candidatos.sort((a, b) => a.distancia - b.distancia);

  for (const c of candidatos) {
    if (slots.length >= maxResultados) break;
    const fin = c.minutos + duracion;
    if (c.minutos < HORA_APERTURA || fin > HORA_CIERRE) continue;
    const conflicto = hayConflicto(c.minutos, fin, citas, especialistaNombre);
    if (!conflicto.conflicto) {
      slots.push(minutosAHora(c.minutos));
    }
  }
  return slots;
}

async function obtenerEspecialistasDisponibles(fecha, hora, duracion) {
  const { data: todos } = await supabase
    .from('especialistas')
    .select('id, nombre, rol, expertise, activo')
    .eq('activo', true);

  if (!todos?.length) return [];

  const citas = await obtenerCitasDelDia(fecha);
  const inicioNuevo = horaAMinutos(hora);
  const finNuevo = inicioNuevo + (duracion || 60);

  const disponibles = todos.filter(esp => {
    const conflicto = hayConflicto(inicioNuevo, finNuevo, citas, esp.nombre);
    return !conflicto.conflicto;
  });

  if (!disponibles.length) return [];

  // Rotación equitativa: ordenar por menor carga últimos 30 días
  const hoy = getFechaEcuador(0);
  const hace30 = getFechaEcuador(-30);
  const carga = await obtenerCargaEspecialistas(hace30, hoy, disponibles.map(e => e.id));

  // Shuffle para romper empates aleatoriamente (no siempre el mismo primero)
  disponibles.sort(() => Math.random() - 0.5);
  disponibles.sort((a, b) => (carga[a.id] || 0) - (carga[b.id] || 0));

  return disponibles;
}

// ═══════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════

async function agregarListaEspera(clienteId, servicioId, servicioNombre, especialistaId, especialistaNombre, fecha, horaPreferida) {
  try {
    const { data, error } = await supabase
      .from('lista_espera')
      .insert({
        cliente_id: clienteId,
        servicio_id: servicioId,
        servicio_aux: servicioNombre,
        especialista_id: especialistaId || null,
        especialista_aux: especialistaNombre || null,
        fecha_deseada: fecha,
        hora_preferida: horaPreferida,
        estado: 'Pendiente',
        created_at: new Date().toISOString()
      })
      .select().single();

    if (error) { console.error('Error insertando lista_espera:', error); return { ok: false }; }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('Error lista_espera:', err.message);
    return { ok: false };
  }
}

async function notificarListaEspera(fecha, hora, duracion, especialistaId, especialistaNombre, servicioId) {
  // Cuando se libera un slot (cancelación), notificar a quien espera ese hueco
  try {
    let query = supabase
      .from('lista_espera')
      .select('*, clientes(telefono, nombre)')
      .eq('estado', 'Pendiente')
      .eq('fecha_deseada', fecha);

    if (especialistaId) query = query.eq('especialista_id', especialistaId);
    if (servicioId) query = query.eq('servicio_id', servicioId);

    const { data: espera } = await query.order('created_at', { ascending: true }).limit(5);
    if (!espera?.length) return [];

    const notificados = [];
    for (const entrada of espera) {
      if (!entrada.clientes?.telefono) continue;

      // Verificar si la hora preferida coincide razonablemente (±60 min)
      const minutosLibre = horaAMinutos(hora);
      const minutosDeseado = horaAMinutos(entrada.hora_preferida || hora);
      if (Math.abs(minutosLibre - minutosDeseado) > 60) continue;

      notificados.push({
        listaEsperaId: entrada.id,
        telefono: entrada.clientes.telefono,
        nombre: entrada.clientes.nombre,
        servicio: entrada.servicio_aux,
        fecha,
        hora,
        especialista: especialistaNombre
      });
    }
    return notificados;
  } catch (err) {
    console.error('Error notificarListaEspera:', err.message);
    return [];
  }
}

async function marcarListaEsperaNotificada(listaEsperaId) {
  await supabase
    .from('lista_espera')
    .update({ estado: 'Notificado', updated_at: new Date().toISOString() })
    .eq('id', listaEsperaId);
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE: INSERTAR / ACTUALIZAR / CANCELAR CITA
// ═══════════════════════════════════════════════════════════════

async function insertarCitaSupabase(cliente, datosPropuesta) {
  const { data, error } = await supabase
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

  if (error) { console.error('Error insert Supabase:', error); return { ok: false, error }; }
  return { ok: true, cita: data };
}

async function reagendarCitaSupabase(citaId, nuevosDatos) {
  const { error } = await supabase
    .from('citas')
    .update({
      especialista_id: nuevosDatos.especialista_id,
      fecha_hora: `${nuevosDatos.fecha}T${nuevosDatos.hora}:00-05:00`,
      servicio_aux: nuevosDatos.servicio,
      duracion_aux: nuevosDatos.duracion,
      updated_at: new Date().toISOString()
    })
    .eq('id', citaId);

  if (error) { console.error('Error reagendar Supabase:', error); return { ok: false }; }
  return { ok: true };
}

async function cancelarCitaSupabase(citaId) {
  const { data: citaOriginal } = await supabase
    .from('citas')
    .select('fecha_hora, especialista_id, duracion_aux, servicio_id, servicio_aux')
    .eq('id', citaId)
    .single();

  const { error } = await supabase
    .from('citas')
    .update({ estado: 'Cancelada', updated_at: new Date().toISOString() })
    .eq('id', citaId);

  if (error) { console.error('Error cancelar Supabase:', error); return { ok: false }; }
  return { ok: true, citaOriginal };
}

// ═══════════════════════════════════════════════════════════════
// GUARDAR MENSAJES EN CONVERSACIONES
// ═══════════════════════════════════════════════════════════════

async function guardarMensajes(telefono, mensajes) {
  // mensajes: [{ rol, contenido }, ...]
  const rows = mensajes.map(m => ({ telefono, rol: m.rol, contenido: m.contenido }));
  const { error } = await supabase.from('conversaciones').insert(rows);
  if (error) console.error('Error guardando mensajes:', error);
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    // ── Transcripción de audio ──
    let textoUsuario = Body || '';
    if (MediaUrl0) {
      try {
        const dgRes = await axios.post(
          'https://api.deepgram.com/v1/listen?model=nova-2&language=es',
          { url: MediaUrl0 },
          { headers: { Authorization: `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        textoUsuario = dgRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || textoUsuario;
      } catch (err) { console.error('Error Deepgram:', err.message); }
    }

    const t = textoUsuario.toLowerCase().trim();

    // ── Cargar datos base ──
    const [clienteRes, especialistasRes, serviciosRes, historialRes] = await Promise.all([
      supabase.from('clientes').select('id, telefono, nombre, apellido, email, fecha_nacimiento, especialista_pref_id, notas_bienestar').eq('telefono', userPhone).maybeSingle(),
      supabase.from('especialistas').select('id, nombre, rol, expertise, activo').eq('activo', true),
      supabase.from('servicios').select('id, nombre, precio, duracion, categoria, descripcion_voda'),
      supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(30)
    ]);

    let cliente = clienteRes.data;
    const especialistas = especialistasRes.data || [];
    const servicios = serviciosRes.data || [];
    const historial = (historialRes.data || []).reverse();
    const ctx = extraerContexto(historial);

    const hoy = getFechaEcuador(0);
    const manana = getFechaEcuador(1);
    const pasado = getFechaEcuador(2);

    const esNuevo = !cliente?.nombre || cliente.nombre.trim() === '';
    const ultimoAssistant = historial.filter(m => m.rol === 'assistant').pop()?.contenido?.toLowerCase() || '';

    let respuesta = '';
    const mensajesSystem = [];

    // ════════════════════════════════════════════════════════
    // FLUJO 1: REGISTRO DE CLIENTE NUEVO
    // ════════════════════════════════════════════════════════
    if (esNuevo) {
      const yaPidio = historial.some(m => m.rol === 'assistant' && /nombre.*apellido|fecha de nacimiento/i.test(m.contenido));

      if (yaPidio) {
        const nombreMatch = textoUsuario.match(/([A-Za-zÁÉÍÓÚáéíóúñÑ]+)(?:\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+))?/);
        const fechaMatch = textoUsuario.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);

        if (nombreMatch && fechaMatch) {
          const nombre = nombreMatch[1].trim();
          const apellido = nombreMatch[2]?.trim() || '';
          const fechaNac = validarFechaNacimiento(`${fechaMatch[1]}/${fechaMatch[2]}/${fechaMatch[3]}`);

          if (nombre && fechaNac) {
            const upsertRes = await supabase.from('clientes')
              .upsert({ telefono: userPhone, nombre, apellido, fecha_nacimiento: fechaNac }, { onConflict: 'telefono' })
              .select().single();
            cliente = upsertRes.data;
            respuesta = `¡Listo, ${nombre}! 🌸 Ya estás en AuraSync. ¿En qué puedo ayudarte hoy?`;
          } else {
            respuesta = 'Necesito tu *nombre y apellido* junto con tu *fecha de nacimiento* (dd/mm/aaaa) para registrarte. 🌸';
          }
        } else {
          respuesta = 'Para registrarte necesito: tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa). 🌸';
        }
      } else {
        respuesta = '¡Hola! 🌸 Soy Aura de AuraSync, encantada. Para registrarte necesito tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa).';
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 2: LISTA DE ESPERA — si el usuario respondió a notificación
    // ════════════════════════════════════════════════════════
    if (ctx.listaEsperaNotif && /^s[ií]|dale|ok|confirmo|perfecto|agéndalo/.test(t)) {
      const notif = ctx.listaEsperaNotif;
      const servicioData = servicios.find(s => s.nombre === notif.servicio);
      const espData = especialistas.find(e => e.nombre === notif.especialista);

      const disponible = await verificarDisponibilidad(notif.fecha, notif.hora, notif.especialista, servicioData?.duracion || 60);
      if (!disponible.ok) {
        respuesta = `Lo siento, ese horario ya fue tomado. 😔 ¿Quieres que te busque otra opción?`;
      } else {
        const insertRes = await insertarCitaSupabase(cliente, {
          fecha: notif.fecha, hora: notif.hora,
          especialista: notif.especialista, especialista_id: espData?.id,
          servicio: notif.servicio, servicio_id: servicioData?.id,
          precio: servicioData?.precio, duracion: servicioData?.duracion
        });

        if (insertRes.ok) {
          await crearCitaAirtable({
            telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
            fecha: notif.fecha, hora: notif.hora, servicio: notif.servicio,
            especialista: notif.especialista, precio: servicioData?.precio,
            duracion: servicioData?.duracion, supabase_id: insertRes.cita.id,
            email: cliente.email, notas: cliente.notas_bienestar, observaciones: 'Asignada desde lista de espera'
          });
          if (notif.listaEsperaId) await marcarListaEsperaNotificada(notif.listaEsperaId);
          respuesta = `✨ ¡Perfecto! Tu cita para *${notif.servicio}* fue confirmada:\n📅 ${formatearFecha(notif.fecha)}\n⏰ ${formatearHora(notif.hora)}\n💇‍♀️ Con ${notif.especialista}\n💰 $${servicioData?.precio || '?'}\n\nTe esperamos con cariño. 🌸`;
        } else {
          respuesta = 'Ups, tuve un error al guardar tu cita. ¿Me das un momento? 🙏';
        }
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 3: CONFIRMACIÓN DE CANCELACIÓN
    // ════════════════════════════════════════════════════════
    if (ctx.cancelarCitaId && /^s[ií]|dale|ok|confirmo|sí, cancelar|cancelar/.test(t)) {
      const cancelRes = await cancelarCitaSupabase(ctx.cancelarCitaId);
      if (cancelRes.ok) {
        const co = cancelRes.citaOriginal;
        const fecha = co?.fecha_hora?.split('T')[0];
        const hora = co?.fecha_hora?.substring(11, 16);
        const espMap = {};
        especialistas.forEach(e => espMap[e.id] = e.nombre);
        const espNombre = espMap[co?.especialista_id] || 'la especialista';

        // Sincronizar Airtable
        await cancelarCitaAirtable(ctx.cancelarCitaId, 'Cancelada por cliente', {
          telefono: userPhone, fecha, hora, especialista: espNombre
        });

        // Notificar lista de espera si el slot quedó libre
        if (fecha && hora) {
          const notificados = await notificarListaEspera(fecha, hora, co?.duracion_aux || 60, co?.especialista_id, espNombre, co?.servicio_id);
          for (const n of notificados) {
            // En producción: enviar WhatsApp a n.telefono con la oferta del slot
            // Por ahora guardamos en contexto del cliente que espera
            const msgNotif = `🌸 Hola ${n.nombre}, se liberó un cupo:\n📅 ${formatearFecha(fecha)}\n⏰ ${formatearHora(hora)}\n💇‍♀️ ${n.servicio} con ${n.especialista}\n\n¿Te lo confirmo? Responde *sí* para reservarlo. ✨`;
            await guardarMensajes(n.telefono, [
              { rol: 'assistant', contenido: msgNotif },
              { rol: 'system', contenido: `LISTA_ESPERA_NOTIF:${JSON.stringify({ ...n, fecha, hora })}` }
            ]);
            await marcarListaEsperaNotificada(n.listaEsperaId);
          }
        }

        respuesta = `Tu cita fue cancelada correctamente. 🌸 Espero verte pronto por AuraSync. ✨`;
      } else {
        respuesta = 'Ups, no pude cancelar tu cita. Por favor intenta de nuevo o comunícate con nosotros. 🙏';
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 4: CONFIRMACIÓN DE CITA (respuesta a "¿Te lo agendo?")
    // ════════════════════════════════════════════════════════
    if (ctx.propuestaCita && /^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va\b|bueno/.test(t)) {
      const dp = ctx.propuestaCita;
      const disponible = await verificarDisponibilidad(dp.fecha, dp.hora, dp.especialista, dp.duracion);

      if (!disponible.ok) {
        const slots = await buscarSlotsLibres(dp.fecha, dp.hora, dp.duracion, dp.especialista, null, 3);
        if (slots.length) {
          const opcionesTexto = slots.map(s => `• ${formatearHora(s)}`).join('\n');
          respuesta = `${disponible.mensaje}\n\nTengo estos horarios libres:\n${opcionesTexto}\n\n¿Cuál prefieres? 🌸`;
          mensajesSystem.push({ rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify({ ...dp, hora: slots[0] })}` });
        } else {
          respuesta = `${disponible.mensaje} Ese día ya no hay cupos. ¿Te parece otro día? 📅`;
        }
      } else {
        const insertRes = await insertarCitaSupabase(cliente, dp);
        if (!insertRes.ok) {
          respuesta = 'Ups, tuve un problema guardando tu cita. ¿Me das un momento? 🙏';
        } else {
          const airtableRes = await crearCitaAirtable({
            telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
            fecha: dp.fecha, hora: dp.hora, servicio: dp.servicio,
            especialista: dp.especialista, precio: dp.precio, duracion: dp.duracion,
            supabase_id: insertRes.cita.id, email: cliente.email,
            notas: cliente.notas_bienestar, observaciones: 'Agendada por Aura'
          });
          respuesta = `✨ ¡Listo! Tu cita está confirmada:\n📅 ${formatearFecha(dp.fecha)}\n⏰ ${formatearHora(dp.hora)}\n💇‍♀️ ${dp.servicio} con ${dp.especialista}\n💰 $${dp.precio}\n\n¡Te esperamos con mucho cariño! 🌸`;
          if (!airtableRes.ok) console.warn('Airtable no sincronizó, pero Supabase sí.');
        }
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 5: REAGENDAR — nueva fecha/hora para cita identificada
    // ════════════════════════════════════════════════════════
    if (ctx.reagendarCitaId) {
      const nuevaFecha = parsearFechaRelativa(textoUsuario, hoy, manana, pasado) || ctx.fechaPropuesta;
      const nuevaHora = parsearHora(textoUsuario) || ctx.horaPropuesta;

      if (!nuevaFecha || !nuevaHora) {
        respuesta = '¿Para qué fecha y hora la quieres mover? (ej: mañana a las 3 p.m.) 📅';
      } else {
        // Recuperar datos de la cita original
        const { data: citaOriginal } = await supabase
          .from('citas')
          .select('servicio_aux, duracion_aux, especialista_id, fecha_hora, servicio_id')
          .eq('id', ctx.reagendarCitaId)
          .single();

        const espMap = {};
        especialistas.forEach(e => espMap[e.id] = e.nombre);
        const espNombre = espMap[citaOriginal?.especialista_id] || null;
        const duracion = citaOriginal?.duracion_aux || 60;

        const disponible = await verificarDisponibilidad(nuevaFecha, nuevaHora, espNombre, duracion, ctx.reagendarCitaId);

        if (!disponible.ok) {
          const slots = await buscarSlotsLibres(nuevaFecha, nuevaHora, duracion, espNombre, ctx.reagendarCitaId, 3);
          if (slots.length) {
            const ops = slots.map(s => `• ${formatearHora(s)}`).join('\n');
            respuesta = `${disponible.mensaje}\n\nTengo disponible:\n${ops}\n\n¿Cuál te funciona? 🌸`;
          } else {
            respuesta = `${disponible.mensaje} ¿Probamos otro día? 📅`;
          }
        } else {
          // Confirmar antes de hacer el cambio
          const fechaAnterior = citaOriginal?.fecha_hora?.split('T')[0];
          const horaAnterior = citaOriginal?.fecha_hora?.substring(11, 16);

          await reagendarCitaSupabase(ctx.reagendarCitaId, {
            fecha: nuevaFecha, hora: nuevaHora,
            especialista_id: citaOriginal?.especialista_id,
            servicio: citaOriginal?.servicio_aux, duracion
          });

          await actualizarCitaAirtable(ctx.reagendarCitaId, {
            telefono: userPhone, fecha: nuevaFecha, hora: nuevaHora,
            especialista: espNombre, fechaAnterior, horaAnterior,
            especialistaAnterior: espNombre, observaciones: 'Reagendada por cliente vía Aura'
          });

          respuesta = `✅ ¡Listo! Tu cita fue movida a:\n📅 ${formatearFecha(nuevaFecha)}\n⏰ ${formatearHora(nuevaHora)}\n💇‍♀️ ${citaOriginal?.servicio_aux} con ${espNombre || 'tu especialista'}\n\nNos vemos pronto. 🌸`;
        }
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 6: SELECCIÓN DE SLOT ALTERNATIVO (usuario eligió hora de lista)
    // ════════════════════════════════════════════════════════
    if (ctx.propuestaCita && parsearHora(textoUsuario)) {
      const nuevaHora = parsearHora(textoUsuario);
      const dp = ctx.propuestaCita;
      const disponible = await verificarDisponibilidad(dp.fecha, nuevaHora, dp.especialista, dp.duracion);

      if (disponible.ok) {
        const propActualizada = { ...dp, hora: nuevaHora };
        respuesta = `Perfecto, te confirmo *${dp.servicio}* con *${dp.especialista}* el *${formatearFecha(dp.fecha)}* a las *${formatearHora(nuevaHora)}*.\n\n¿Te lo agendo? ✨`;
        mensajesSystem.push({ rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify(propActualizada)}` });
      } else {
        respuesta = `Ese horario tampoco está disponible. ¿Quieres que te sugiera otros? 🌸`;
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 7: REAGENDAR — listar citas
    // ════════════════════════════════════════════════════════
    if (/reagendar|mover|cambiar.*cita|modificar.*cita/.test(t)) {
      const { data: citasConfirmadas } = await supabase
        .from('citas')
        .select('id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', `${hoy}T00:00:00`)
        .order('fecha_hora', { ascending: true })
        .limit(10);

      if (!citasConfirmadas?.length) {
        respuesta = 'No encontré citas activas a tu nombre. ¿Quieres que agende una nueva? 💫';
      } else {
        const espMap = {};
        especialistas.forEach(e => espMap[e.id] = e.nombre);

        if (citasConfirmadas.length === 1) {
          const c = citasConfirmadas[0];
          const f = c.fecha_hora.split('T')[0];
          const h = c.fecha_hora.substring(11, 16);
          respuesta = `Tienes una cita de *${c.servicio_aux}* el *${formatearFecha(f)}* a las *${formatearHora(h)}*.\n\n¿Para qué fecha y hora la quieres mover? 📅`;
          mensajesSystem.push({ rol: 'system', contenido: `REAGENDAR_CITA_ID:${c.id}` });
        } else {
          const lista = citasConfirmadas.map((c, i) => {
            const f = c.fecha_hora.split('T')[0];
            const h = c.fecha_hora.substring(11, 16);
            return `${i + 1}. *${c.servicio_aux}* — ${formatearFecha(f)} a las ${formatearHora(h)}`;
          }).join('\n');
          respuesta = `Tienes ${citasConfirmadas.length} citas confirmadas:\n${lista}\n\n¿Cuál quieres mover? Responde con el número. 💫`;
        }
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // Selección numérica cuando se listaron citas para reagendar
    if (/^\d+$/.test(t.trim()) && ultimoAssistant.includes('cuál quieres mover')) {
      const idx = parseInt(t.trim()) - 1;
      const { data: citasConfirmadas } = await supabase
        .from('citas')
        .select('id, servicio_aux, fecha_hora, especialista_id')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', `${hoy}T00:00:00`)
        .order('fecha_hora', { ascending: true })
        .limit(10);

      const cita = citasConfirmadas?.[idx];
      if (cita) {
        const f = cita.fecha_hora.split('T')[0];
        const h = cita.fecha_hora.substring(11, 16);
        respuesta = `Cita seleccionada: *${cita.servicio_aux}* del *${formatearFecha(f)}* a las *${formatearHora(h)}*.\n\n¿Para qué fecha y hora la quieres mover? 📅`;
        mensajesSystem.push({ rol: 'system', contenido: `REAGENDAR_CITA_ID:${cita.id}` });
      } else {
        respuesta = 'No encontré esa opción. Responde con el número de la lista. 🌸';
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 8: CANCELAR — listar citas
    // ════════════════════════════════════════════════════════
    if (/cancelar|anular.*cita|eliminar.*cita/.test(t)) {
      const { data: citasConfirmadas } = await supabase
        .from('citas')
        .select('id, servicio_aux, fecha_hora, especialista_id')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', `${hoy}T00:00:00`)
        .order('fecha_hora', { ascending: true })
        .limit(10);

      if (!citasConfirmadas?.length) {
        respuesta = 'No encontré citas activas a tu nombre. 🌸';
      } else {
        const espMap = {};
        especialistas.forEach(e => espMap[e.id] = e.nombre);

        if (citasConfirmadas.length === 1) {
          const c = citasConfirmadas[0];
          const f = c.fecha_hora.split('T')[0];
          const h = c.fecha_hora.substring(11, 16);
          respuesta = `¿Quieres cancelar tu cita de *${c.servicio_aux}* del *${formatearFecha(f)}* a las *${formatearHora(h)}*?\n\nResponde *sí* para confirmar. 🌸`;
          mensajesSystem.push({ rol: 'system', contenido: `CANCELAR_CITA_ID:${c.id}` });
        } else {
          const lista = citasConfirmadas.map((c, i) => {
            const f = c.fecha_hora.split('T')[0];
            const h = c.fecha_hora.substring(11, 16);
            return `${i + 1}. *${c.servicio_aux}* — ${formatearFecha(f)} a las ${formatearHora(h)}`;
          }).join('\n');
          respuesta = `¿Cuál cita quieres cancelar?\n${lista}\n\nResponde con el número. 🌸`;
        }
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // Selección numérica cuando se listaron citas para cancelar
    if (/^\d+$/.test(t.trim()) && ultimoAssistant.includes('cuál cita quieres cancelar')) {
      const idx = parseInt(t.trim()) - 1;
      const { data: citasConfirmadas } = await supabase
        .from('citas')
        .select('id, servicio_aux, fecha_hora')
        .eq('cliente_id', cliente.id)
        .eq('estado', 'Confirmada')
        .gte('fecha_hora', `${hoy}T00:00:00`)
        .order('fecha_hora', { ascending: true })
        .limit(10);

      const cita = citasConfirmadas?.[idx];
      if (cita) {
        const f = cita.fecha_hora.split('T')[0];
        const h = cita.fecha_hora.substring(11, 16);
        respuesta = `¿Confirmas cancelar *${cita.servicio_aux}* del *${formatearFecha(f)}* a las *${formatearHora(h)}*?\n\nResponde *sí* para cancelar. 🌸`;
        mensajesSystem.push({ rol: 'system', contenido: `CANCELAR_CITA_ID:${cita.id}` });
      } else {
        respuesta = 'No encontré esa opción. Responde con el número de la lista. 🌸';
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

    // ════════════════════════════════════════════════════════
    // FLUJO 9: AGENDAR — procesar fecha+hora+especialista
    // ════════════════════════════════════════════════════════
    {
      // Detectar servicio (del mensaje actual o del contexto)
      let servicioData = null;
      for (const s of servicios) {
        const match = t.includes(s.nombre.toLowerCase()) || t.includes((s.categoria || '').toLowerCase());
        if (match) { servicioData = s; break; }
      }
      if (!servicioData && ctx.servicioSeleccionado) {
        servicioData = servicios.find(s => s.nombre === ctx.servicioSeleccionado);
      }

      // Detectar fecha y hora
      const fecha = parsearFechaRelativa(textoUsuario, hoy, manana, pasado) || ctx.fechaPropuesta;
      const hora = parsearHora(textoUsuario) || ctx.horaPropuesta;

      // Detectar especialista mencionado en el mensaje
      let espSeleccionado = null;
      for (const esp of especialistas) {
        if (t.includes(esp.nombre.toLowerCase())) {
          espSeleccionado = esp;
          break;
        }
      }
      if (!espSeleccionado && ctx.especialistaPropuesto) {
        espSeleccionado = especialistas.find(e => e.nombre === ctx.especialistaPropuesto);
      }

      // ── Si no sabe el servicio, listar ──
      if (!servicioData && !ctx.servicioSeleccionado) {
        const lista = servicios.map(s => `• *${s.nombre}* — $${s.precio}, ${s.duracion} min`).join('\n');
        respuesta = `¡Hola ${cliente.nombre}! 🌸 Soy Aura. Estos son nuestros servicios:\n${lista}\n\n¿Cuál te gustaría agendar?`;

        await guardarMensajes(userPhone, [
          { rol: 'user', contenido: textoUsuario },
          { rol: 'assistant', contenido: respuesta }
        ]);
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
      }

      // Guardar servicio si es nuevo
      if (servicioData && servicioData.nombre !== ctx.servicioSeleccionado) {
        mensajesSystem.push({ rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData.nombre}` });
      }

      // ── Si no tiene fecha/hora, pedirla ──
      if (!fecha || !hora) {
        const sNombre = servicioData?.nombre || ctx.servicioSeleccionado || 'tu servicio';
        if (!fecha) {
          respuesta = `Excelente elección ✨ *${sNombre}*. ¿Para qué día te funciona? (hoy, mañana, o dd/mm/aaaa)`;
        } else {
          respuesta = `¿A qué hora te funciona para el ${formatearFecha(fecha)}? (entre 9:00 a.m. y 6:00 p.m.) 🕐`;
          mensajesSystem.push({ rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` });
        }

        await guardarMensajes(userPhone, [
          { rol: 'user', contenido: textoUsuario },
          ...mensajesSystem,
          { rol: 'assistant', contenido: respuesta }
        ]);
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
      }

      const duracion = servicioData?.duracion || 60;

      // ── Si no tiene especialista, buscar disponibles y mostrar mínimo 2 ──
      if (!espSeleccionado) {
        const disponibles = await obtenerEspecialistasDisponibles(fecha, hora, duracion);

        if (!disponibles.length) {
          const slots = await buscarSlotsLibres(fecha, hora, duracion, null, null, 3);
          if (slots.length) {
            const ops = slots.map(s => `• ${formatearHora(s)}`).join('\n');
            respuesta = `No hay cupos a las ${formatearHora(hora)} el ${formatearFecha(fecha)}. Tengo disponible:\n${ops}\n\n¿Cuál te funciona? 🌸`;
            mensajesSystem.push({ rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` });
          } else {
            respuesta = `Ese día ya no tenemos cupos disponibles. ¿Te parece otro día? 📅`;
          }
        } else {
          // Mostrar entre 2 y 3 especialistas disponibles (rotación equitativa)
          const top = disponibles.slice(0, Math.min(3, disponibles.length));
          const lista = top.map(e => `• *${e.nombre}* — ${e.expertise || e.rol || 'Especialista'}`).join('\n');
          respuesta = `Para *${servicioData?.nombre}* a las ${formatearHora(hora)} del ${formatearFecha(fecha)}, tengo disponible a:\n${lista}\n\n¿Con quién te gustaría? ✨`;
          mensajesSystem.push(
            { rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` },
            { rol: 'system', contenido: `HORA_PROPUESTA:${hora}` }
          );
        }

        await guardarMensajes(userPhone, [
          { rol: 'user', contenido: textoUsuario },
          ...mensajesSystem,
          { rol: 'assistant', contenido: respuesta }
        ]);
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
      }

      // ── Tiene fecha, hora y especialista — verificar y proponer ──
      const disponible = await verificarDisponibilidad(fecha, hora, espSeleccionado.nombre, duracion);

      if (!disponible.ok) {
        const slots = await buscarSlotsLibres(fecha, hora, duracion, espSeleccionado.nombre, null, 3);
        if (slots.length) {
          const ops = slots.map(s => `• ${formatearHora(s)}`).join('\n');
          respuesta = `${disponible.mensaje}\n\nTengo a *${espSeleccionado.nombre}* disponible en:\n${ops}\n\n¿Cuál te funciona? 🌸`;
        } else {
          // Ofrecer otro especialista disponible
          const otrosDisp = await obtenerEspecialistasDisponibles(fecha, hora, duracion);
          const otroEsp = otrosDisp.find(e => e.id !== espSeleccionado.id);
          if (otroEsp) {
            respuesta = `${disponible.mensaje}\n\n¿Te parece con *${otroEsp.nombre}* (${otroEsp.expertise || otroEsp.rol}) a las ${formatearHora(hora)}? ✨`;
            mensajesSystem.push(
              { rol: 'system', contenido: `ESPECIALISTA_PROPUESTO:${otroEsp.nombre}` },
              { rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify({ fecha, hora, especialista: otroEsp.nombre, especialista_id: otroEsp.id, servicio: servicioData?.nombre, servicio_id: servicioData?.id, precio: servicioData?.precio, duracion })}` }
            );
          } else {
            respuesta = `${disponible.mensaje} Ese día ya no hay cupos. ¿Te parece otro día? 📅`;
          }
        }
      } else {
        // Todo disponible — proponer confirmación
        const propuesta = {
          fecha, hora,
          especialista: espSeleccionado.nombre,
          especialista_id: espSeleccionado.id,
          servicio: servicioData?.nombre,
          servicio_id: servicioData?.id,
          precio: servicioData?.precio,
          duracion
        };
        respuesta = `Perfecto, te confirmo:\n📅 ${formatearFecha(fecha)}\n⏰ ${formatearHora(hora)}\n💇‍♀️ *${servicioData?.nombre}* con *${espSeleccionado.nombre}*\n💰 $${servicioData?.precio}\n\n¿Te lo agendo? ✨`;
        mensajesSystem.push(
          { rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify(propuesta)}` },
          { rol: 'system', contenido: `ESPECIALISTA_PROPUESTO:${espSeleccionado.nombre}` }
        );
      }

      await guardarMensajes(userPhone, [
        { rol: 'user', contenido: textoUsuario },
        ...mensajesSystem,
        { rol: 'assistant', contenido: respuesta }
      ]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
    }

  } catch (err) {
    console.error('❌ Error General:', err.message, err.stack);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problemita técnico. ¿Me das un segundito? 🌸</Message></Response>');
  }
}
