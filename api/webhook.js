import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID:    process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN:      process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY:    process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY:      process.env.OPENAI_API_KEY,
};

const TIMEZONE        = 'America/Guayaquil';
const HORA_APERTURA   = 540;   // 09:00 en minutos
const HORA_CIERRE     = 1080;  // 18:00 en minutos
const SLOT_PASO       = 15;    // granularidad de slots

// ═══════════════════════════════════════════════════════════════
// FECHA / HORA
// ═══════════════════════════════════════════════════════════════

function getFechaEcuador(offsetDias = 0) {
  const ahora   = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const parts   = new Intl.DateTimeFormat('en-US', opciones).formatToParts(ahora);
  const year    = parseInt(parts.find(p => p.type === 'year')?.value  || '2026');
  const month   = parseInt(parts.find(p => p.type === 'month')?.value || '1');
  const day     = parseInt(parts.find(p => p.type === 'day')?.value   || '1');
  const fecha   = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO || 'fecha por confirmar';
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0))
    .toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatearHora(horaStr) {
  if (!horaStr) return '';
  const [h, m] = horaStr.split(':').map(Number);
  const periodo = h >= 12 ? 'p.m.' : 'a.m.';
  const h12     = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

function validarFechaNacimiento(fechaStr) {
  if (!fechaStr) return null;
  const partes = fechaStr.split(/[\/-]/);
  if (partes.length !== 3) return null;
  const dia  = parseInt(partes[0], 10);
  const mes  = parseInt(partes[1], 10);
  const anio = parseInt(partes[2], 10);
  if (isNaN(dia) || isNaN(mes) || isNaN(anio)) return null;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  if (anio < 1900 || anio > new Date().getFullYear()) return null;
  const diasPorMes = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if ((anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0) diasPorMes[1] = 29;
  if (dia > diasPorMes[mes - 1]) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function horaAMin(horaStr) {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

function minAHora(min) {
  return `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE — CRUD ROBUSTO
// ═══════════════════════════════════════════════════════════════

async function buscarCitaAirtable({ supabaseId, telefono, fecha, hora, especialista }) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const hdr = { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` };

    if (supabaseId) {
      const f = encodeURIComponent(`{ID_Supabase} = '${supabaseId}'`);
      const r = await axios.get(`${url}?filterByFormula=${f}`, { headers: hdr });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    if (telefono && fecha && hora) {
      const conds = [`{Teléfono} = '${telefono}'`, `IS_SAME({Fecha}, '${fecha}', 'days')`, `{Hora} = '${hora}'`];
      if (especialista) conds.push(`{Especialista} = '${especialista}'`);
      const f = encodeURIComponent(`AND(${conds.join(', ')})`);
      const r = await axios.get(`${url}?filterByFormula=${f}`, { headers: hdr });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    if (telefono && fecha) {
      const f = encodeURIComponent(`AND({Teléfono} = '${telefono}', IS_SAME({Fecha}, '${fecha}', 'days'))`);
      const r = await axios.get(`${url}?filterByFormula=${f}`, { headers: hdr });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    return { ok: false, error: 'No encontrado' };
  } catch (err) {
    console.error('Airtable buscar:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    const r = await axios.post(url, {
      records: [{ fields: {
        "Cliente":                      `${datos.nombre} ${datos.apellido}`.trim(),
        "Servicio":                     datos.servicio,
        "Fecha":                        fechaUTC,
        "Hora":                         datos.hora,
        "Especialista":                 datos.especialista,
        "Teléfono":                     datos.telefono,
        "Estado":                       "Confirmada",
        "Importe estimado":             datos.precio,
        "Duración estimada (minutos)":  datos.duracion,
        "ID_Supabase":                  datos.supabase_id   || null,
        "Email de cliente":             datos.email         || null,
        "Notas de la cita":             datos.notas         || null,
        "Observaciones de confirmación": datos.observaciones || null,
      }}]
    }, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { ok: true, recordId: r.data.records?.[0]?.id };
  } catch (err) {
    console.error('Airtable crear:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function actualizarCitaAirtable(supabaseId, nuevosDatos) {
  try {
    const url     = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({
      supabaseId,
      telefono:         nuevosDatos.telefono,
      fecha:            nuevosDatos.fechaAnterior,
      hora:             nuevosDatos.horaAnterior,
      especialista:     nuevosDatos.especialistaAnterior,
    });
    if (!busqueda.ok) return { ok: false, error: 'No encontrado en Airtable' };

    const [h, min] = nuevosDatos.hora.split(':').map(Number);
    const [anio, mes, dia] = nuevosDatos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    const payload  = {
      records: [{ id: busqueda.record.id, fields: {
        "Fecha":                         fechaUTC,
        "Hora":                          nuevosDatos.hora,
        "Especialista":                  nuevosDatos.especialista,
        "Estado":                        "Confirmada",
        "Observaciones de confirmación": nuevosDatos.observaciones || "Cita reagendada por cliente",
      }}]
    };
    if (supabaseId && !busqueda.record.fields.ID_Supabase) {
      payload.records[0].fields["ID_Supabase"] = supabaseId;
    }
    await axios.patch(url, payload, {
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    });
    return { ok: true, recordId: busqueda.record.id };
  } catch (err) {
    console.error('Airtable actualizar:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function cancelarCitaAirtable(supabaseId, motivo, datosFallback) {
  try {
    const url     = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({
      supabaseId,
      telefono:     datosFallback?.telefono,
      fecha:        datosFallback?.fecha,
      hora:         datosFallback?.hora,
      especialista: datosFallback?.especialista,
    });
    if (!busqueda.ok) return { ok: false, error: 'No encontrado en Airtable' };
    await axios.patch(url, {
      records: [{ id: busqueda.record.id, fields: {
        "Estado":                        "Cancelada",
        "Observaciones de confirmación": motivo ? `Cancelada: ${motivo}` : "Cancelada por cliente",
      }}]
    }, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { ok: true, recordId: busqueda.record.id };
  } catch (err) {
    console.error('Airtable cancelar:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// DISPONIBILIDAD
// ═══════════════════════════════════════════════════════════════

async function obtenerCitasDelDia(fecha, excluirId = null) {
  try {
    let q = supabase
      .from('citas')
      .select('id, fecha_hora, especialista_id, duracion_aux, servicio_aux')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', `${fecha}T00:00:00`)
      .lte('fecha_hora', `${fecha}T23:59:59`);
    if (excluirId) q = q.neq('id', excluirId);

    const { data: citas, error } = await q;
    if (error) { console.error('Supabase citas día:', error); return []; }

    const { data: esps } = await supabase.from('especialistas').select('id, nombre');
    const mapaEsp = {};
    (esps || []).forEach(e => { mapaEsp[e.id] = e.nombre; });

    const resultado = (citas || []).map(c => ({
      id:          c.id,
      hora:        c.fecha_hora?.substring(11, 16) || null,
      duracion:    c.duracion_aux || 60,
      especialista: mapaEsp[c.especialista_id] || 'Asignar',
      especialista_id: c.especialista_id,
      servicio:    c.servicio_aux,
    })).filter(c => c.hora);

    console.log(`📅 Citas del día ${fecha}:`, resultado.length);
    resultado.forEach(c => console.log(`   ${c.hora} — ${c.especialista} — ${c.servicio}`));
    return resultado;
  } catch (err) {
    console.error('obtenerCitasDelDia:', err.message);
    return [];
  }
}

async function verificarDisponibilidad(fecha, hora, especialistaNombre, duracionMin, excluirId = null) {
  const citas   = await obtenerCitasDelDia(fecha, excluirId);
  const inicio  = horaAMin(hora);
  const fin     = inicio + (duracionMin || 60);

  if (inicio < HORA_APERTURA) return { ok: false, mensaje: 'Nuestro horario comienza a las 9:00 a.m. 🌅' };
  if (fin > HORA_CIERRE)      return { ok: false, mensaje: 'Ese horario supera nuestra jornada (hasta las 6:00 p.m.). ¿Te funciona más temprano?' };

  for (const c of citas) {
    if (!c.hora) continue;
    if (especialistaNombre && c.especialista !== especialistaNombre) continue;
    const ci = horaAMin(c.hora);
    const cf = ci + (c.duracion || 60);
    if (inicio < cf && fin > ci) {
      return {
        ok: false,
        mensaje: `Ups, ese horario ya está ocupado${c.servicio ? ` con un ${c.servicio}` : ''}. 😔`,
        conflictoCon: c,
      };
    }
  }
  return { ok: true };
}

// Busca el primer slot libre desde horaPref (avanza en pasos de SLOT_PASO minutos)
async function buscarAlternativa(fecha, horaPref, especialistaNombre, duracion, excluirId = null) {
  const citas = await obtenerCitasDelDia(fecha, excluirId);
  let t = horaAMin(horaPref);

  while (t <= HORA_CIERRE - duracion) {
    const fin = t + duracion;
    let conflicto = false;
    for (const c of citas) {
      if (!c.hora) continue;
      if (especialistaNombre && c.especialista !== especialistaNombre) continue;
      const ci = horaAMin(c.hora);
      const cf = ci + (c.duracion || 60);
      if (t < cf && fin > ci) { conflicto = true; break; }
    }
    if (!conflicto) {
      const horaStr = minAHora(t);
      return { mensaje: `¿Qué tal a las ${formatearHora(horaStr)}?`, hora: horaStr };
    }
    t += SLOT_PASO;
  }
  return { mensaje: 'Ese día ya no tenemos cupos disponibles. ¿Te parece otro día? 📅', hora: null };
}

// Devuelve hasta maxSlots horarios libres cercanos a horaPref (avanzando Y retrocediendo)
async function buscarSlotsLibres(fecha, horaPref, duracion, especialistaNombre = null, excluirId = null, maxSlots = 3) {
  const citas      = await obtenerCitasDelDia(fecha, excluirId);
  const base       = horaAMin(horaPref);
  const candidatos = [];

  for (let t = base; t <= HORA_CIERRE - duracion; t += SLOT_PASO) {
    candidatos.push({ min: t, dist: t - base });
  }
  for (let t = base - SLOT_PASO; t >= HORA_APERTURA; t -= SLOT_PASO) {
    candidatos.push({ min: t, dist: base - t });
  }
  candidatos.sort((a, b) => a.dist - b.dist);

  const slots = [];
  for (const cand of candidatos) {
    if (slots.length >= maxSlots) break;
    const fin = cand.min + duracion;
    if (cand.min < HORA_APERTURA || fin > HORA_CIERRE) continue;
    let libre = true;
    for (const c of citas) {
      if (!c.hora) continue;
      if (especialistaNombre && c.especialista !== especialistaNombre) continue;
      const ci = horaAMin(c.hora);
      const cf = ci + (c.duracion || 60);
      if (cand.min < cf && fin > ci) { libre = false; break; }
    }
    if (libre) slots.push(minAHora(cand.min));
  }
  return slots;
}

// Especialistas disponibles, ordenados por menor carga (rotación equitativa)
async function especialistasDisponibles(fecha, hora, duracion, todosEsps) {
  if (!todosEsps?.length) return [];
  const citas  = await obtenerCitasDelDia(fecha);
  const inicio = horaAMin(hora);
  const fin    = inicio + (duracion || 60);

  const disponibles = todosEsps.filter(esp => {
    for (const c of citas) {
      if (c.especialista !== esp.nombre) continue;
      const ci = horaAMin(c.hora);
      const cf = ci + (c.duracion || 60);
      if (inicio < cf && fin > ci) return false;
    }
    return true;
  });
  if (!disponibles.length) return [];

  // Carga de los últimos 30 días
  const hace30 = getFechaEcuador(-30);
  const hoy    = getFechaEcuador(0);
  const { data: cargaData } = await supabase
    .from('citas')
    .select('especialista_id')
    .eq('estado', 'Confirmada')
    .gte('fecha_hora', `${hace30}T00:00:00`)
    .lte('fecha_hora', `${hoy}T23:59:59`)
    .in('especialista_id', disponibles.map(e => e.id));

  const carga = {};
  disponibles.forEach(e => { carga[e.id] = 0; });
  (cargaData || []).forEach(c => { if (carga[c.especialista_id] !== undefined) carga[c.especialista_id]++; });

  // Shuffle para romper empates aleatoriamente
  disponibles.sort(() => Math.random() - 0.5);
  disponibles.sort((a, b) => (carga[a.id] || 0) - (carga[b.id] || 0));
  return disponibles;
}

// ═══════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════

async function agregarListaEspera(clienteId, servicioId, servicioNombre, especialistaId, fecha, hora) {
  try {
    const { data, error } = await supabase.from('lista_espera').insert({
      cliente_id:      clienteId,
      servicio_id:     servicioId   || null,
      servicio_aux:    servicioNombre,
      especialista_id: especialistaId || null,
      fecha_deseada:   fecha,
      hora_preferida:  hora,
      estado:          'Pendiente',
    }).select().single();
    if (error) { console.error('lista_espera insert:', error); return { ok: false }; }
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('agregarListaEspera:', err.message);
    return { ok: false };
  }
}

async function notificarListaEspera(fecha, hora, especialistaId, servicioId) {
  try {
    let q = supabase
      .from('lista_espera')
      .select('id, cliente_id, servicio_aux, hora_preferida, clientes(telefono, nombre)')
      .eq('estado', 'Pendiente')
      .eq('fecha_deseada', fecha);
    if (especialistaId) q = q.eq('especialista_id', especialistaId);
    if (servicioId)     q = q.eq('servicio_id', servicioId);

    const { data: espera } = await q.order('created_at', { ascending: true }).limit(5);
    if (!espera?.length) return [];

    const notificados = [];
    const minLibre = horaAMin(hora);
    for (const e of espera) {
      if (!e.clientes?.telefono) continue;
      const minDeseado = e.hora_preferida ? horaAMin(e.hora_preferida) : minLibre;
      if (Math.abs(minLibre - minDeseado) > 60) continue;
      notificados.push({ id: e.id, telefono: e.clientes.telefono, nombre: e.clientes.nombre, servicio: e.servicio_aux });
    }
    return notificados;
  } catch (err) {
    console.error('notificarListaEspera:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    // ── Transcripción de voz ──────────────────────────────────
    let textoUsuario = Body || '';
    if (MediaUrl0) {
      try {
        const dgRes = await axios.post(
          'https://api.deepgram.com/v1/listen?model=nova-2&language=es',
          { url: MediaUrl0 },
          { headers: { Authorization: `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        textoUsuario = dgRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || textoUsuario;
      } catch (err) { console.error('Deepgram:', err.message); }
    }

    // ── Carga paralela de datos ───────────────────────────────
    const [clienteRes, especialistasRes, serviciosRes, historialRes] = await Promise.all([
      supabase.from('clientes')
        .select('id, telefono, nombre, apellido, email, fecha_nacimiento, especialista_pref_id, notas_bienestar')
        .eq('telefono', userPhone).maybeSingle(),
      supabase.from('especialistas')
        .select('id, nombre, rol, expertise, local_id, activo').eq('activo', true),
      supabase.from('servicios')
        .select('id, nombre, precio, duracion, categoria, descripcion_voda'),
      supabase.from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(14),
    ]);

    let cliente         = clienteRes.data;
    const especialistas = especialistasRes.data || [];
    const servicios     = serviciosRes.data    || [];
    const historial     = (historialRes.data   || []).reverse();

    const esNuevo = !cliente?.nombre || cliente.nombre.trim() === '';

    const hoy          = getFechaEcuador(0);
    const manana       = getFechaEcuador(1);
    const pasadoManana = getFechaEcuador(2);

    const yaSePidieronDatos = esNuevo && historial.some(
      m => m.rol === 'assistant' &&
           (m.contenido.toLowerCase().includes('nombre') || m.contenido.toLowerCase().includes('registr'))
    );

    // ── Catálogos para el prompt ──────────────────────────────
    const catalogoEsps = especialistas
      .map(e => `- ${e.nombre}${e.expertise ? ` (${e.expertise})` : ''}${e.rol ? ` — ${e.rol}` : ''}`)
      .join('\n') || '(consultar con recepción)';

    const catalogoSvcs = servicios
      .map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion} min${s.categoria ? ` [${s.categoria}]` : ''}${s.descripcion_voda ? ` — ${s.descripcion_voda}` : ''}`)
      .join('\n') || '(consultar con recepción)';

    // ── Detectar oferta de lista de espera pendiente ──────────
    const ultimoSystem = [...historial].reverse().find(m => m.rol === 'system')?.contenido || '';
    const esRespuestaListaEspera =
      ultimoSystem.startsWith('LISTA_ESPERA_OFERTA:') &&
      /^s[ií]|dale|ok|confirmo|perfecto|agéndalo|sí/i.test(textoUsuario.trim());

    // ═══════════════════════════════════════════════════════════
    // SYSTEM PROMPT
    // ═══════════════════════════════════════════════════════════
    const systemPrompt = `Eres Aura, coordinadora de AuraSync — un centro de bienestar y belleza.
Para el cliente eres completamente humana: cálida, atenta, elegante y genuinamente interesada en ellos.
Conoces personalmente a cada especialista y cada servicio.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATOS REALES DEL NEGOCIO — NUNCA INVENTAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ESPECIALISTAS (solo estos existen):
${catalogoEsps}

SERVICIOS (solo estos existen):
${catalogoSvcs}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTADO DEL CLIENTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${esNuevo
  ? `⚠️ CLIENTE NUEVO — número no registrado en el sistema.

FLUJO DE REGISTRO — OBLIGATORIO SIN EXCEPCIONES:
1. Saluda con calidez y preséntate como Aura de AuraSync.
2. En ESE MISMO primer mensaje pide TODOS los datos JUNTOS:
   • Nombre y apellido
   • Fecha de nacimiento (formato dd/mm/aaaa)
   Ejemplo: "¡Hola! 🌸 Soy Aura de AuraSync, encantada. Para registrarte necesito tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa). ¿Me los compartes?"
3. Cuando el cliente responda → extrae los datos y usa accion "registrar".
4. Confirma el registro cálidamente y pregunta en qué puedes ayudar.
CRÍTICO: NUNCA pidas un dato por mensaje. SIEMPRE los datos juntos.
${yaSePidieronDatos ? 'NOTA: Ya se solicitaron los datos antes. Si el cliente responde ahora, extrae y registra.' : ''}`
  : `✅ CLIENTE REGISTRADO — ${cliente.nombre} ${cliente.apellido || ''}
No pidas datos que ya tenemos.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSONALIDAD Y TONO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Mensajes cortos como WhatsApp real. Máximo 2–3 oraciones, salvo confirmaciones de cita.
- Varía tus aperturas y cierres. NUNCA repitas la misma frase dos veces seguidas en la conversación.
- Usa emojis con moderación: 🌸 ✨ 💫 📅. Máximo 1–2 por mensaje. Nunca al inicio de cada oración.
- NUNCA uses frases de chatbot: "¡Con gusto!", "¡Claro que sí!", "Como asistente...", "Entendido".
- Si te preguntan si eres humana o un bot: responde natural y ambiguamente. Ej: "Soy Aura 😊, aquí para lo que necesites."
- Si hay limitaciones (sin cupo), sé directa y propositiva, sin dramatizar ni disculparte en exceso.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FLUJO DE AGENDAMIENTO — UN PASO POR MENSAJE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Paso 1 — Servicio: Pregunta SOLO si el cliente no lo dijo todavía.

Paso 2 — Especialistas: SIEMPRE presenta MÍNIMO 2 con expertise real.
  "Para [servicio] te puedo ofrecer a:
  • *[Nombre 1]* — [expertise]
  • *[Nombre 2]* — [expertise]
  ¿Con quién te gustaría?"

Paso 3 — Fecha y hora:
  • Si el cliente ya dijo la hora → confírmala directamente, no preguntes de nuevo.
  • Si no → pregunta qué día y hora le funciona.

Paso 4 — Confirmación: Espera "sí", "dale", "ok", "agéndalo", "perfecto", "va", "confirmo".

Paso 5 — Ejecución: accion "agendar" en el JSON. SOLO después de confirmación explícita.

REGLAS ANTI-REDUNDANCIA (CRÍTICAS):
• Si el cliente dijo "a las 17:00" → NO preguntes "¿te parece a las 5 p.m.?" → Confirma directamente.
• Si eligió especialista → NO vuelvas a preguntar "¿con [nombre]?".
• NUNCA combines saludo + especialista + horario en el mismo mensaje.
• Máximo 4 intercambios para llegar a la confirmación.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REAGENDAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Muestra PRIMERO las citas del cliente:
   "Tienes [N] cita(s) confirmada(s):
   1. [Servicio] el [fecha] a las [hora] con [especialista]
   ¿Cuál quieres mover?"
2. Cuando indique cuál → propón nueva fecha/hora.
3. Cuando confirme → accion "reagendar" en el JSON.
OBLIGATORIO en el JSON: "cita_fecha_original" (YYYY-MM-DD) y "cita_hora_original" (HH:MM).
NUNCA cambies el servicio al reagendar.
NUNCA inventes la fecha/hora original. Si no estás segura, pregunta.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANCELAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Confirma cuál cita quiere cancelar.
2. Pide confirmación ("sí" o similar).
3. Con confirmación → accion "cancelar".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LISTA DE ESPERA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Si no hay cupo y el cliente quiere esperar → accion "lista_espera".
Hazlo sentir que su solicitud es importante: "Te anoto y te aviso en cuanto se libere un lugar. 💫"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FECHAS DE REFERENCIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hoy:           ${formatearFecha(hoy)} (${hoy})
Mañana:        ${formatearFecha(manana)} (${manana})
Pasado mañana: ${formatearFecha(pasadoManana)} (${pasadoManana})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA_JSON — OBLIGATORIO AL FINAL DE CADA RESPUESTA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATA_JSON:{
  "accion": "none" | "registrar" | "agendar" | "cancelar" | "reagendar" | "lista_espera",
  "nombre": "",
  "apellido": "",
  "fecha_nacimiento": "DD/MM/AAAA",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "nombre exacto de la lista",
  "cita_especialista": "nombre exacto de la lista o vacío",
  "cita_fecha_original": "YYYY-MM-DD",
  "cita_hora_original": "HH:MM",
  "motivo": ""
}

REGLAS:
• "cita_hora" siempre en formato 24h HH:MM (ej: "17:00", "09:30").
• "accion":"agendar" SOLO tras confirmación explícita del cliente.
• "accion":"reagendar" SOLO tras confirmación de nueva fecha/hora. Siempre incluir cita_fecha_original y cita_hora_original.
• "accion":"cancelar" SOLO tras confirmación explícita de cancelación.
• "accion":"registrar" cuando el cliente dé nombre + apellido + fecha de nacimiento.
• "accion":"lista_espera" cuando no haya cupo y el cliente quiera esperar aviso.
• "accion":"none" en cualquier otro caso (conversación, preguntas, presentación de opciones).
• Los campos vacíos se dejan como "".`;

    // ── Construir mensajes OpenAI ─────────────────────────────
    const messages = [{ role: 'system', content: systemPrompt }];
    historial
      .filter(m => m.rol === 'user' || m.rol === 'assistant')
      .forEach(m => messages.push({ role: m.rol === 'assistant' ? 'assistant' : 'user', content: m.contenido }));
    messages.push({ role: 'user', content: textoUsuario });

    // ── Llamada a OpenAI ──────────────────────────────────────
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model:       'gpt-4o',
      messages,
      temperature: 0.2,
      max_tokens:  500,
    }, {
      headers: { Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` },
      timeout: 25000,
    });

    const fullReply = aiRes.data.choices[0].message.content;

    // ── Extraer DATA_JSON ─────────────────────────────────────
    let datos = {};
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?"accion"[\s\S]*?\})/i);
    if (jsonMatch) {
      try { datos = JSON.parse(jsonMatch[1].trim()); }
      catch (e) { console.error('JSON parse error:', e.message); }
    }

    const accion       = datos.accion || 'none';
    let cleanReply     = fullReply.replace(/DATA_JSON[\s\S]*$/i, '').trim();
    let mensajeAccion  = '';
    let accionEjecutada = false;

    // ── Resolver fecha final ──────────────────────────────────
    const tLower = (textoUsuario || '').toLowerCase();
    let fechaFinal = manana;
    if (tLower.includes('hoy'))               fechaFinal = hoy;
    else if (tLower.includes('pasado mañana')) fechaFinal = pasadoManana;
    else if (tLower.includes('mañana'))        fechaFinal = manana;
    if (datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/)) fechaFinal = datos.cita_fecha;

    // ────────────────────────────────────────────────────────
    // 0 ── RESPUESTA A OFERTA DE LISTA DE ESPERA
    // ────────────────────────────────────────────────────────
    if (esRespuestaListaEspera) {
      try {
        const oferta    = JSON.parse(ultimoSystem.replace('LISTA_ESPERA_OFERTA:', ''));
        const svcData   = servicios.find(s => s.nombre === oferta.servicio);
        const disponible = await verificarDisponibilidad(oferta.fecha, oferta.hora, null, svcData?.duracion || 60);

        if (!disponible.ok) {
          mensajeAccion = 'Ese horario ya fue tomado. ¿Quieres que busque otra opción? 🌸';
        } else if (cliente?.id) {
          const { data: citaSupa, error: insErr } = await supabase.from('citas').insert({
            cliente_id:         cliente.id,
            servicio_id:        svcData?.id || null,
            especialista_id:    null,
            fecha_hora:         `${oferta.fecha}T${oferta.hora}:00-05:00`,
            estado:             'Confirmada',
            nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
            servicio_aux:       oferta.servicio,
            duracion_aux:       svcData?.duracion || 60,
          }).select().single();

          if (!insErr) {
            await crearCitaAirtable({
              telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
              fecha: oferta.fecha, hora: oferta.hora, servicio: oferta.servicio,
              especialista: 'Asignar', precio: svcData?.precio || 0, duracion: svcData?.duracion || 60,
              supabase_id: citaSupa.id, email: cliente.email, notas: cliente.notas_bienestar,
              observaciones: 'Confirmada desde lista de espera',
            });
            if (oferta.listaEsperaId) {
              await supabase.from('lista_espera').update({ estado: 'Confirmada' }).eq('id', oferta.listaEsperaId);
            }
            mensajeAccion = `✨ ¡Perfecto! Tu cita fue confirmada:\n📅 ${formatearFecha(oferta.fecha)}\n⏰ ${formatearHora(oferta.hora)}\n💇‍♀️ ${oferta.servicio}\n\n¡Te esperamos! 🌸`;
          } else {
            mensajeAccion = 'Tuve un problema guardando la cita. ¿Lo intentamos de nuevo? 🙏';
          }
        }
        accionEjecutada = true;
      } catch (err) {
        console.error('Lista espera respuesta:', err.message);
      }
    }

    // ────────────────────────────────────────────────────────
    // 1 ── REGISTRAR CLIENTE NUEVO
    // ────────────────────────────────────────────────────────
    if (!accionEjecutada && accion === 'registrar' && esNuevo) {
      const nombre   = (datos.nombre   || '').trim();
      const apellido = (datos.apellido || '').trim();
      const fechaNacISO = validarFechaNacimiento(datos.fecha_nacimiento || '');

      if (!nombre || !apellido) {
        mensajeAccion   = 'Necesito tu *nombre y apellido* completos para registrarte. 🌸';
        accionEjecutada = true;
      } else if (!fechaNacISO) {
        mensajeAccion   = 'La fecha de nacimiento no es válida. ¿Me la compartes en formato *dd/mm/aaaa*? Ejemplo: 15/03/1990 🌸';
        accionEjecutada = true;
      } else {
        const { data: nuevoCli, error: insErr } = await supabase
          .from('clientes')
          .insert({ telefono: userPhone, nombre, apellido, fecha_nacimiento: fechaNacISO })
          .select().single();

        if (insErr?.code === '23505') {
          const { data: updCli, error: updErr } = await supabase
            .from('clientes')
            .update({ nombre, apellido, fecha_nacimiento: fechaNacISO })
            .eq('telefono', userPhone).select().single();
          if (updErr) {
            mensajeAccion = 'Tuve un problema registrando tus datos. ¿Lo intentamos de nuevo? 🙏';
          } else {
            cliente       = updCli;
            mensajeAccion = `¡Listo, ${nombre}! 🌸 Ya estás en AuraSync. ¿En qué puedo ayudarte hoy?`;
          }
        } else if (insErr) {
          console.error('Registrar cliente:', insErr);
          mensajeAccion = 'Tuve un problema registrando tus datos. ¿Lo intentamos de nuevo? 🙏';
        } else {
          cliente       = nuevoCli;
          mensajeAccion = `¡Listo, ${nombre}! 🌸 Ya estás en AuraSync. ¿En qué puedo ayudarte hoy?`;
        }
        accionEjecutada = true;
      }
    }

    // ────────────────────────────────────────────────────────
    // 2 ── AGENDAR
    // ────────────────────────────────────────────────────────
    if (!accionEjecutada && accion === 'agendar') {
      if (esNuevo && !cliente?.id) {
        mensajeAccion   = 'Primero necesito registrarte. ¿Me compartes tu *nombre, apellido* y *fecha de nacimiento* (dd/mm/aaaa)? 🌸';
        accionEjecutada = true;
      } else if (!datos.cita_hora?.match(/^\d{2}:\d{2}$/)) {
        mensajeAccion   = '¿A qué hora te funciona? (entre 9:00 a.m. y 6:00 p.m.) 🕐';
        accionEjecutada = true;
      } else {
        // Resolver servicio
        const svcData = servicios.find(s => s.nombre.toLowerCase() === (datos.cita_servicio || '').toLowerCase())
          || servicios.find(s => s.nombre.toLowerCase().includes((datos.cita_servicio || '').toLowerCase()))
          || { id: null, nombre: datos.cita_servicio || 'Servicio', precio: 0, duracion: 60 };

        // Resolver especialista — si no especificó, asignar por rotación
        let espData = especialistas.find(e => e.nombre.toLowerCase() === (datos.cita_especialista || '').toLowerCase())
          || especialistas.find(e => e.nombre.toLowerCase().includes((datos.cita_especialista || '').toLowerCase()))
          || null;

        if (!espData && !datos.cita_especialista) {
          const disponibles = await especialistasDisponibles(fechaFinal, datos.cita_hora, svcData.duracion, especialistas);
          espData = disponibles[0] || null;
        }

        const disponible = await verificarDisponibilidad(
          fechaFinal, datos.cita_hora, espData?.nombre || null, svcData.duracion
        );

        if (!disponible.ok) {
          const slots = await buscarSlotsLibres(fechaFinal, datos.cita_hora, svcData.duracion, espData?.nombre || null);
          if (slots.length) {
            const ops = slots.map(s => `• ${formatearHora(s)}`).join('\n');
            mensajeAccion = `${disponible.mensaje}\n\nTengo estos horarios disponibles:\n${ops}\n\n¿Cuál te funciona? 🌸`;
          } else {
            // Intentar otro especialista disponible
            const otrosDisp = await especialistasDisponibles(fechaFinal, datos.cita_hora, svcData.duracion, especialistas);
            const otro = otrosDisp.find(e => e.id !== espData?.id);
            if (otro) {
              mensajeAccion = `${disponible.mensaje}\n\n¿Te parece con *${otro.nombre}* a la misma hora? ✨`;
            } else {
              mensajeAccion = `${disponible.mensaje} Ese día ya no hay cupos disponibles. ¿Probamos otro día? 📅`;
            }
          }
          accionEjecutada = true;
        } else {
          const espNombre = espData?.nombre || 'Asignar';
          const espId     = espData?.id     || null;

          const { data: citaSupa, error: insErr } = await supabase.from('citas').insert({
            cliente_id:         cliente?.id || null,
            servicio_id:        svcData.id  || null,
            especialista_id:    espId,
            fecha_hora:         `${fechaFinal}T${datos.cita_hora}:00-05:00`,
            estado:             'Confirmada',
            nombre_cliente_aux: `${datos.nombre || cliente?.nombre || ''} ${datos.apellido || cliente?.apellido || ''}`.trim(),
            servicio_aux:       svcData.nombre,
            duracion_aux:       svcData.duracion,
          }).select().single();

          if (insErr) {
            console.error('Agendar Supabase:', insErr);
            mensajeAccion = 'Ups, tuve un problema guardando tu cita. ¿Me das un momento? 🙏';
          } else {
            console.log('✅ Cita creada en Supabase, ID:', citaSupa.id);
            const atRes = await crearCitaAirtable({
              telefono:     userPhone,
              nombre:       datos.nombre   || cliente?.nombre    || '',
              apellido:     datos.apellido || cliente?.apellido  || '',
              fecha:        fechaFinal,
              hora:         datos.cita_hora,
              servicio:     svcData.nombre,
              especialista: espNombre,
              precio:       svcData.precio,
              duracion:     svcData.duracion,
              supabase_id:  citaSupa.id,
              email:        cliente?.email            || null,
              notas:        cliente?.notas_bienestar  || null,
              observaciones: 'Agendada por Aura',
            });

            if (atRes.ok) {
              mensajeAccion = `✨ ¡Listo! Tu cita está confirmada:\n📅 ${formatearFecha(fechaFinal)}\n⏰ ${formatearHora(datos.cita_hora)}\n💇‍♀️ ${svcData.nombre} con ${espNombre}\n💰 $${svcData.precio}\n\nTe esperamos con mucho cariño. 🌸`;
            } else {
              mensajeAccion = `✅ Tu cita está guardada:\n📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(datos.cita_hora)}\n💇‍♀️ ${svcData.nombre} con ${espNombre}`;
            }
          }
          accionEjecutada = true;
        }
      }
    }

    // ────────────────────────────────────────────────────────
    // 3 ── REAGENDAR
    // ────────────────────────────────────────────────────────
    if (!accionEjecutada && accion === 'reagendar') {
      if (!datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/) || !datos.cita_hora?.match(/^\d{2}:\d{2}$/)) {
        mensajeAccion   = '¿Para qué fecha y hora quieres mover la cita? (ej: mañana a las 3 p.m.) 📅';
        accionEjecutada = true;
      } else {
        const clienteId  = cliente?.id;
        const nomCliente = cliente?.nombre   || '';
        const apeCliente = cliente?.apellido || '';

        // Buscar citas del cliente
        let todasCitas = [];
        if (clienteId) {
          const { data: c1 } = await supabase.from('citas')
            .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
            .eq('cliente_id', clienteId).eq('estado', 'Confirmada')
            .order('fecha_hora', { ascending: true }).limit(10);
          if (c1?.length) todasCitas = c1;
        }
        if (!todasCitas.length && (nomCliente || apeCliente)) {
          const nomBusq = `${nomCliente} ${apeCliente}`.trim();
          const { data: c2 } = await supabase.from('citas')
            .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
            .ilike('nombre_cliente_aux', `%${nomBusq}%`).eq('estado', 'Confirmada')
            .order('fecha_hora', { ascending: true }).limit(10);
          if (c2?.length) todasCitas = c2;
        }

        if (!todasCitas.length) {
          mensajeAccion   = 'No encontré citas confirmadas a tu nombre. ¿Quieres agendar una nueva? 💫';
          accionEjecutada = true;
        } else {
          // Mapear especialistas
          const mapaEsp = {};
          especialistas.forEach(e => { mapaEsp[e.id] = e.nombre; });
          todasCitas = todasCitas.map(c => ({ ...c, espNombre: mapaEsp[c.especialista_id] || 'Asignar' }));

          // ── Identificar cuál cita mover (4 estrategias) ──
          let citaAMover = null;

          // Estrategia A: fecha_original + hora_original del JSON
          if (datos.cita_fecha_original && datos.cita_hora_original) {
            citaAMover = todasCitas.find(c =>
              c.fecha_hora?.split('T')[0] === datos.cita_fecha_original &&
              c.fecha_hora?.substring(11, 16) === datos.cita_hora_original
            );
            if (citaAMover) console.log('✅ Reagendar: encontrada por fecha+hora original del JSON');
          }
          // Estrategia B: servicio del JSON
          if (!citaAMover && datos.cita_servicio) {
            citaAMover = todasCitas.find(c =>
              c.servicio_aux?.toLowerCase().includes(datos.cita_servicio.toLowerCase())
            );
            if (citaAMover) console.log('✅ Reagendar: encontrada por servicio');
          }
          // Estrategia C: fecha/hora extraída del texto del usuario
          if (!citaAMover) {
            let fMenc = null;
            if (tLower.includes('hoy'))               fMenc = hoy;
            else if (tLower.includes('pasado mañana')) fMenc = pasadoManana;
            else if (tLower.includes('mañana'))        fMenc = manana;

            const horaM = textoUsuario.match(/(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:am|pm|a\.m\.|p\.m\.)?/i);
            let hMenc = null;
            if (horaM) {
              let hh = parseInt(horaM[1], 10);
              const mm = horaM[2] ? parseInt(horaM[2], 10) : 0;
              const sufijo = (horaM[0] || '').toLowerCase();
              if (/pm|p\.m\./.test(sufijo) && hh < 12) hh += 12;
              hMenc = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
            }
            if (fMenc && hMenc) {
              citaAMover = todasCitas.find(c =>
                c.fecha_hora?.split('T')[0] === fMenc && c.fecha_hora?.substring(11, 16) === hMenc
              );
            } else if (fMenc) {
              const mismaFecha = todasCitas.filter(c => c.fecha_hora?.split('T')[0] === fMenc);
              if (mismaFecha.length === 1) citaAMover = mismaFecha[0];
            }
            if (citaAMover) console.log('✅ Reagendar: encontrada por texto del usuario');
          }
          // Estrategia D: única cita disponible
          if (!citaAMover && todasCitas.length === 1) {
            citaAMover = todasCitas[0];
            console.log('✅ Reagendar: única cita, fallback automático');
          }

          if (!citaAMover) {
            // Pedir clarificación
            const lista = todasCitas.map((c, i) => {
              const f = c.fecha_hora?.split('T')[0];
              const h = c.fecha_hora?.substring(11, 16);
              return `${i + 1}. *${c.servicio_aux}* — ${formatearFecha(f)} a las ${formatearHora(h)} con ${c.espNombre}`;
            }).join('\n');
            mensajeAccion   = `Veo que tienes ${todasCitas.length} citas confirmadas:\n${lista}\n\n¿Cuál quieres mover? Responde con el número. 💫`;
            accionEjecutada = true;
          } else {
            // ── Ejecutar reagendamiento ──
            const svcActual = servicios.find(s => s.id === citaAMover.servicio_id)
              || { id: null, nombre: citaAMover.servicio_aux, precio: 0, duracion: citaAMover.duracion_aux || 60 };

            const espOrigNombre = citaAMover.espNombre;
            const espOrigId     = citaAMover.especialista_id;
            let   espFinalNombre = espOrigNombre;
            let   espFinalId     = espOrigId;

            // Si el cliente quiere cambiar de especialista
            if (datos.cita_especialista) {
              const nuevoEsp = especialistas.find(e =>
                e.nombre.toLowerCase() === datos.cita_especialista.toLowerCase()
              );
              if (nuevoEsp) { espFinalNombre = nuevoEsp.nombre; espFinalId = nuevoEsp.id; }
            }

            const fechaNueva  = datos.cita_fecha;
            const horaNueva   = datos.cita_hora;
            const fechaAntes  = citaAMover.fecha_hora?.split('T')[0];
            const horaAntes   = citaAMover.fecha_hora?.substring(11, 16);

            console.log('🔄 Reagendando:', { de: `${fechaAntes} ${horaAntes}`, a: `${fechaNueva} ${horaNueva}`, esp: espFinalNombre });

            const disponible = await verificarDisponibilidad(
              fechaNueva, horaNueva, espFinalNombre, svcActual.duracion, citaAMover.id
            );

            if (!disponible.ok) {
              const slots = await buscarSlotsLibres(fechaNueva, horaNueva, svcActual.duracion, espFinalNombre, citaAMover.id);
              if (slots.length) {
                const ops = slots.map(s => `• ${formatearHora(s)}`).join('\n');
                mensajeAccion = `${disponible.mensaje}\n\nTengo disponible:\n${ops}\n\n¿Cuál te funciona? 🌸`;
              } else {
                mensajeAccion = `${disponible.mensaje} Ese día ya no hay cupos. ¿Probamos otro día? 📅`;
              }
              accionEjecutada = true;
            } else {
              const { data: updData, error: updErr } = await supabase.from('citas')
                .update({
                  fecha_hora:         `${fechaNueva}T${horaNueva}:00-05:00`,
                  estado:             'Confirmada',
                  especialista_id:    espFinalId,
                  nombre_cliente_aux: `${nomCliente} ${apeCliente}`.trim(),
                  servicio_id:        citaAMover.servicio_id,
                  servicio_aux:       citaAMover.servicio_aux,
                  duracion_aux:       citaAMover.duracion_aux,
                })
                .eq('id', citaAMover.id)
                .select();

              if (updErr || !updData?.length) {
                console.error('Reagendar Supabase:', updErr);
                mensajeAccion = 'Tuve un problema moviendo tu cita. ¿Lo intentamos de nuevo? 🙏';
              } else {
                console.log('✅ Supabase reagendado, filas:', updData.length);
                const atRes = await actualizarCitaAirtable(citaAMover.id, {
                  fecha: fechaNueva, hora: horaNueva, especialista: espFinalNombre,
                  observaciones: `Reagendada de ${fechaAntes} ${horaAntes} → ${fechaNueva} ${horaNueva}`,
                  telefono: userPhone, fechaAnterior: fechaAntes, horaAnterior: horaAntes,
                  especialistaAnterior: espOrigNombre,
                });

                if (atRes.ok) {
                  mensajeAccion = `✨ ¡Cita movida!\n\nDe: ${formatearFecha(fechaAntes)} a las ${formatearHora(horaAntes)}\nA: 📅 ${formatearFecha(fechaNueva)} a las ${formatearHora(horaNueva)}\n💇‍♀️ ${svcActual.nombre} con ${espFinalNombre}\n\n¡Nos vemos pronto! 🌸`;
                } else {
                  mensajeAccion = `✅ Tu cita de *${svcActual.nombre}* fue movida a ${formatearFecha(fechaNueva)} a las ${formatearHora(horaNueva)} con ${espFinalNombre}. 🌸`;
                }
              }
              accionEjecutada = true;
            }
          }
        }
      }
    }

    // ────────────────────────────────────────────────────────
    // 4 ── CANCELAR
    // ────────────────────────────────────────────────────────
    if (!accionEjecutada && accion === 'cancelar') {
      const clienteId  = cliente?.id;
      let todasCitas   = [];

      if (clienteId) {
        const { data: c1 } = await supabase.from('citas')
          .select('id, servicio_aux, fecha_hora, especialista_id, duracion_aux, servicio_id')
          .eq('cliente_id', clienteId).eq('estado', 'Confirmada')
          .order('fecha_hora', { ascending: true }).limit(10);
        if (c1?.length) todasCitas = c1;
      }
      if (!todasCitas.length && cliente) {
        const nomBusq = `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim();
        if (nomBusq) {
          const { data: c2 } = await supabase.from('citas')
            .select('id, servicio_aux, fecha_hora, especialista_id, duracion_aux, servicio_id')
            .ilike('nombre_cliente_aux', `%${nomBusq}%`).eq('estado', 'Confirmada')
            .order('fecha_hora', { ascending: true }).limit(10);
          if (c2?.length) todasCitas = c2;
        }
      }

      const mapaEsp = {};
      especialistas.forEach(e => { mapaEsp[e.id] = e.nombre; });
      todasCitas = todasCitas.map(c => ({ ...c, espNombre: mapaEsp[c.especialista_id] || 'Asignar' }));

      let citaACancelar = null;
      if (todasCitas.length) {
        if (datos.cita_servicio) {
          citaACancelar = todasCitas.find(c =>
            c.servicio_aux?.toLowerCase().includes(datos.cita_servicio.toLowerCase())
          );
        }
        if (!citaACancelar) citaACancelar = todasCitas[0];
      }

      if (!citaACancelar) {
        mensajeAccion = 'No encontré citas activas a tu nombre para cancelar. 🌸';
      } else {
        const fCita = citaACancelar.fecha_hora?.split('T')[0];
        const hCita = citaACancelar.fecha_hora?.substring(11, 16);

        const { error: cancelErr } = await supabase.from('citas')
          .update({ estado: 'Cancelada' })
          .eq('id', citaACancelar.id);

        if (cancelErr) {
          console.error('Cancelar Supabase:', cancelErr);
          mensajeAccion = 'Tuve un problema cancelando tu cita. ¿Me das un momento? 🙏';
        } else {
          console.log('✅ Cita cancelada en Supabase:', citaACancelar.id);

          // Notificar lista de espera
          const enEspera = await notificarListaEspera(fCita, hCita, citaACancelar.especialista_id, citaACancelar.servicio_id);
          for (const e of enEspera) {
            await supabase.from('conversaciones').insert([
              {
                telefono: e.telefono, rol: 'assistant',
                contenido: `🌸 Hola ${e.nombre}, se liberó un cupo:\n📅 ${formatearFecha(fCita)}\n⏰ ${formatearHora(hCita)}${e.servicio ? `\n💇‍♀️ ${e.servicio}` : ''}\n\n¿Te lo confirmo? Responde *sí* y te lo reservo. ✨`,
              },
              {
                telefono: e.telefono, rol: 'system',
                contenido: `LISTA_ESPERA_OFERTA:${JSON.stringify({ listaEsperaId: e.id, fecha: fCita, hora: hCita, servicio: e.servicio })}`,
              },
            ]);
            await supabase.from('lista_espera').update({ estado: 'Notificado' }).eq('id', e.id);
          }

          await cancelarCitaAirtable(citaACancelar.id, datos.motivo || 'Cancelada por cliente', {
            telefono: userPhone, fecha: fCita, hora: hCita, especialista: citaACancelar.espNombre,
          });

          mensajeAccion = `Tu cita de *${citaACancelar.servicio_aux}* del ${formatearFecha(fCita)} fue cancelada. Lamentamos no verte esta vez, ¡pero aquí estaremos cuando nos necesites! 🌸`;
        }
      }
      accionEjecutada = true;
    }

    // ────────────────────────────────────────────────────────
    // 5 ── LISTA DE ESPERA
    // ────────────────────────────────────────────────────────
    if (!accionEjecutada && accion === 'lista_espera' && cliente?.id) {
      const svcData = servicios.find(s => s.nombre.toLowerCase().includes((datos.cita_servicio || '').toLowerCase()));
      const espData = especialistas.find(e => e.nombre.toLowerCase().includes((datos.cita_especialista || '').toLowerCase()));
      const res     = await agregarListaEspera(
        cliente.id, svcData?.id || null, datos.cita_servicio || 'Servicio',
        espData?.id || null, fechaFinal, datos.cita_hora || '10:00'
      );
      mensajeAccion   = res.ok
        ? `Perfecto, te anoto en lista de espera para *${datos.cita_servicio || 'tu servicio'}* el ${formatearFecha(fechaFinal)}. En cuanto se libere un cupo te aviso de inmediato. 💫`
        : 'Tuve un problemita anotándote. ¿Lo intentamos de nuevo? 🙏';
      accionEjecutada = true;
    }

    // ── Respuesta final ───────────────────────────────────────
    const respuestaFinal = (accionEjecutada && mensajeAccion) ? mensajeAccion : cleanReply;

    // ── Persistir en Supabase ─────────────────────────────────
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user',      contenido: textoUsuario   },
      { telefono: userPhone, rol: 'assistant', contenido: respuestaFinal },
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${respuestaFinal}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error General:', err.message, err.stack);
    return res.status(200).send(
      '<Response><Message>Lo siento, tuve un problemita técnico. ¿Me das un segundito? 🌸</Message></Response>'
    );
  }
}
