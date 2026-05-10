// Aura v3
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

const TIMEZONE      = 'America/Guayaquil';
const HORA_APERTURA = 540;   // 09:00
const HORA_CIERRE   = 1080;  // 18:00
const SLOT_PASO     = 15;

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

function resolverDiaSemana(nombreDia) {
  const sinTilde = nombreDia.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const diasEN   = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const idx      = diasEN.indexOf(sinTilde);
  if (idx === -1) return null;
  const hoy      = getFechaEcuador(0);
  const [y, m, d] = hoy.split('-').map(Number);
  const base     = new Date(Date.UTC(y, m - 1, d));
  const diaHoy   = base.getUTCDay();
  let offset     = idx - diaHoy;
  if (offset <= 0) offset += 7;
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().split('T')[0];
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
  const diasPorMes = [31,28,31,30,31,30,31,31,30,31,30,31];
  if ((anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0) diasPorMes[1] = 29;
  if (dia > diasPorMes[mes - 1]) return null;
  return `${anio}-${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
}

function horaAMin(horaStr) {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

function minAHora(min) {
  return `${Math.floor(min / 60).toString().padStart(2,'0')}:${(min % 60).toString().padStart(2,'0')}`;
}

function esDiaLaborable(fechaISO) {
  const [a, m, d] = fechaISO.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay() !== 0; // domingo = 0
}

function parsearHoraNatural(texto) {
  const t = texto.toLowerCase();
  const matchManana = t.match(/(\d{1,2})(?::(\d{2}))?\s*de\s*la\s*ma[ñn]ana/);
  if (matchManana) {
    const h = parseInt(matchManana[1], 10);
    const m = matchManana[2] ? parseInt(matchManana[2], 10) : 0;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const matchTarde = t.match(/(\d{1,2})(?::(\d{2}))?\s*de\s*la\s*tarde/);
  if (matchTarde) {
    let h = parseInt(matchTarde[1], 10);
    const m = matchTarde[2] ? parseInt(matchTarde[2], 10) : 0;
    if (h < 12) h += 12;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const matchNoche = t.match(/(\d{1,2})(?::(\d{2}))?\s*de\s*la\s*noche/);
  if (matchNoche) {
    let h = parseInt(matchNoche[1], 10);
    const m = matchNoche[2] ? parseInt(matchNoche[2], 10) : 0;
    if (h < 12) h += 12;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const match = t.match(/(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (match) {
    let hh = parseInt(match[1], 10);
    const mm = match[2] ? parseInt(match[2], 10) : 0;
    const suf = (match[3] || '').toLowerCase();
    if (/pm|p\.m\./.test(suf) && hh < 12) hh += 12;
    if (/am|a\.m\./.test(suf) && hh === 12) hh = 0;
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'00')}`;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE
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
      const [a, m, d] = fecha.split('-').map(Number);
      const fInicio = new Date(Date.UTC(a, m-1, d, 0,  0,  0)).toISOString();
      const fFin    = new Date(Date.UTC(a, m-1, d, 23, 59, 59)).toISOString();
      const conds   = [
        `{Teléfono} = '${telefono}'`, `{Hora} = '${hora}'`,
        `IS_AFTER({Fecha}, '${fInicio}')`, `IS_BEFORE({Fecha}, '${fFin}')`,
      ];
      if (especialista) conds.push(`{Especialista} = '${especialista}'`);
      const r = await axios.get(`${url}?filterByFormula=${encodeURIComponent(`AND(${conds.join(',')})`)}`, { headers: hdr });
      if (r.data.records?.length) return { ok: true, record: r.data.records[0] };
    }
    if (telefono && fecha) {
      const [a, m, d] = fecha.split('-').map(Number);
      const fInicio = new Date(Date.UTC(a, m-1, d, 0,  0,  0)).toISOString();
      const fFin    = new Date(Date.UTC(a, m-1, d, 23, 59, 59)).toISOString();
      const f = encodeURIComponent(`AND({Teléfono}='${telefono}',IS_AFTER({Fecha},'${fInicio}'),IS_BEFORE({Fecha},'${fFin}'))`);
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
    const fechaISO = `${datos.fecha}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
    const r = await axios.post(url, {
      records: [{ fields: {
        'Cliente':                      `${datos.nombre} ${datos.apellido}`.trim(),
        'Servicio':                     datos.servicio,
        'Fecha':                        fechaISO,
        'Hora':                         datos.hora,
        'Especialista':                 datos.especialista,
        'Teléfono':                     datos.telefono,
        'Estado':                       'Confirmada',
        'Importe estimado':             datos.precio,
        'Duración estimada (minutos)':  datos.duracion,
        'ID_Supabase':                  datos.supabase_id   || null,
        'Email de cliente':             datos.email         || null,
        'Notas de la cita':             datos.notas         || null,
        'Observaciones de confirmación': datos.observaciones || null,
      }}]
    }, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { ok: true, recordId: r.data.records?.[0]?.id };
  } catch (err) {
    console.error('Airtable crear:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function actualizarCitaAirtable(supabaseId, nd) {
  try {
    const url     = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({ supabaseId, telefono: nd.telefono, fecha: nd.fechaAnterior, hora: nd.horaAnterior, especialista: nd.especialistaAnterior });
    if (!busqueda.ok) return { ok: false, error: 'No encontrado en Airtable' };
    const [h, min] = nd.hora.split(':').map(Number);
    const fechaISO = `${nd.fecha}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
    const payload  = { records: [{ id: busqueda.record.id, fields: {
      'Fecha': fechaISO, 'Hora': nd.hora, 'Especialista': nd.especialista,
      'Estado': 'Confirmada', 'Observaciones de confirmación': nd.observaciones || 'Cita reagendada por cliente',
    }}] };
    if (supabaseId && !busqueda.record.fields.ID_Supabase) payload.records[0].fields['ID_Supabase'] = supabaseId;
    await axios.patch(url, payload, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return { ok: true, recordId: busqueda.record.id };
  } catch (err) {
    console.error('Airtable actualizar:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

async function cancelarCitaAirtable(supabaseId, motivo, fb) {
  try {
    const url     = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const busqueda = await buscarCitaAirtable({ supabaseId, telefono: fb?.telefono, fecha: fb?.fecha, hora: fb?.hora, especialista: fb?.especialista });
    if (!busqueda.ok) return { ok: false, error: 'No encontrado en Airtable' };
    await axios.patch(url, { records: [{ id: busqueda.record.id, fields: {
      'Estado': 'Cancelada',
      'Observaciones de confirmación': motivo ? `Cancelada: ${motivo}` : 'Cancelada por cliente',
    }}] }, { headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
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
      .in('estado', ['Confirmada', 'Pendiente'])
      .gte('fecha_hora', `${fecha}T00:00:00`)
      .lte('fecha_hora', `${fecha}T23:59:59`);
    if (excluirId) q = q.neq('id', excluirId);
    const { data: citas, error } = await q;
    if (error) { console.error('Supabase citas día:', error); return []; }
    const { data: esps } = await supabase.from('especialistas').select('id, nombre');
    const mapaEsp = {};
    (esps || []).forEach(e => { mapaEsp[e.id] = e.nombre; });
    return (citas || []).map(c => ({
      id: c.id,
      hora: c.fecha_hora?.substring(11, 16) || null,
      duracion: c.duracion_aux || 60,
      especialista: mapaEsp[c.especialista_id] || 'Asignar',
      especialista_id: c.especialista_id,
      servicio: c.servicio_aux,
    })).filter(c => c.hora);
  } catch (err) {
    console.error('obtenerCitasDelDia:', err.message);
    return [];
  }
}

async function verificarDisponibilidad(fecha, hora, especialistaNombre, duracionMin, excluirId = null) {
  if (!esDiaLaborable(fecha)) return { ok: false, mensaje: 'Los domingos no atendemos. ¿Te funciona otro día? 📅' };
  const citas  = await obtenerCitasDelDia(fecha, excluirId);
  const inicio = horaAMin(hora);
  const fin    = inicio + (duracionMin || 60);
  if (inicio < HORA_APERTURA) return { ok: false, mensaje: 'Nuestro horario comienza a las 9:00 a.m. 🌅' };
  if (fin > HORA_CIERRE)      return { ok: false, mensaje: 'Ese horario supera nuestra jornada (hasta las 6:00 p.m.). ¿Te funciona más temprano?' };
  for (const c of citas) {
    if (!c.hora) continue;
    if (especialistaNombre && c.especialista !== especialistaNombre) continue;
    const ci = horaAMin(c.hora);
    const cf = ci + (c.duracion || 60);
    if (inicio < cf && fin > ci) return { ok: false, mensaje: `Ese horario ya está ocupado${c.servicio ? ` con un ${c.servicio}` : ''}. 😔`, conflictoCon: c };
  }
  return { ok: true };
}

async function buscarSlotsLibres(fecha, horaPref, duracion, especialistaNombre = null, excluirId = null, maxSlots = 3) {
  if (!esDiaLaborable(fecha)) return [];
  const citas      = await obtenerCitasDelDia(fecha, excluirId);
  const base       = horaAMin(horaPref);
  const candidatos = [];
  for (let t = base; t <= HORA_CIERRE - duracion; t += SLOT_PASO) candidatos.push({ min: t, dist: t - base });
  for (let t = base - SLOT_PASO; t >= HORA_APERTURA; t -= SLOT_PASO) candidatos.push({ min: t, dist: base - t });
  candidatos.sort((a, b) => a.dist - b.dist);
  const slots = [];
  for (const cand of candidatos) {
    if (slots.length >= maxSlots) break;
    if (cand.min < HORA_APERTURA || cand.min + duracion > HORA_CIERRE) continue;
    let libre = true;
    for (const c of citas) {
      if (!c.hora) continue;
      if (especialistaNombre && c.especialista !== especialistaNombre) continue;
      const ci = horaAMin(c.hora);
      const cf = ci + (c.duracion || 60);
      if (cand.min < cf && (cand.min + duracion) > ci) { libre = false; break; }
    }
    if (libre) slots.push(minAHora(cand.min));
  }
  return slots;
}

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
  const hace30 = getFechaEcuador(-30);
  const hoy    = getFechaEcuador(0);
  const { data: cargaData } = await supabase
    .from('citas').select('especialista_id')
    .in('estado', ['Confirmada','Pendiente'])
    .gte('fecha_hora', `${hace30}T00:00:00`)
    .lte('fecha_hora', `${hoy}T23:59:59`)
    .in('especialista_id', disponibles.map(e => e.id));
  const carga = {};
  disponibles.forEach(e => { carga[e.id] = 0; });
  (cargaData || []).forEach(c => { if (carga[c.especialista_id] !== undefined) carga[c.especialista_id]++; });
  // Agrupar por carga y shuffle dentro de cada grupo
  const agrupados = {};
  disponibles.forEach(e => {
    const k = carga[e.id] || 0;
    if (!agrupados[k]) agrupados[k] = [];
    agrupados[k].push(e);
  });
  const resultado = [];
  Object.keys(agrupados).map(Number).sort((a, b) => a - b).forEach(k => {
    const g = agrupados[k];
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    resultado.push(...g);
  });
  return resultado;
}

// ═══════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════

async function agregarListaEspera(clienteId, servicioId, servicioNombre, especialistaId, fecha, hora) {
  try {
    const { data, error } = await supabase.from('lista_espera').insert({
      cliente_id: clienteId, servicio_id: servicioId || null,
      servicio_aux: servicioNombre, especialista_id: especialistaId || null,
      fecha_deseada: fecha, hora_preferida: hora, estado: 'Pendiente',
    }).select().single();
    if (error) { console.error('lista_espera insert:', error); return { ok: false }; }
    return { ok: true, id: data.id };
  } catch (err) { console.error('agregarListaEspera:', err.message); return { ok: false }; }
}

async function notificarListaEspera(fecha, hora, especialistaId, servicioId) {
  try {
    let q = supabase.from('lista_espera')
      .select('id, cliente_id, servicio_aux, hora_preferida, clientes(telefono, nombre)')
      .eq('estado', 'Pendiente').eq('fecha_deseada', fecha);
    if (especialistaId) q = q.eq('especialista_id', especialistaId);
    if (servicioId)     q = q.eq('servicio_id', servicioId);
    const { data: espera } = await q.order('created_at', { ascending: true }).limit(10);
    if (!espera?.length) return [];
    const minLibre = horaAMin(hora);
    return espera
      .filter(e => e.clientes?.telefono && Math.abs(minLibre - (e.hora_preferida ? horaAMin(e.hora_preferida) : minLibre)) <= 120)
      .map(e => ({ id: e.id, telefono: e.clientes.telefono, nombre: e.clientes.nombre, servicio: e.servicio_aux }));
  } catch (err) { console.error('notificarListaEspera:', err.message); return []; }
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    // ── 1. Transcripción de voz ───────────────────────────────
    let textoUsuario = Body || '';
    if (MediaUrl0) {
      try {
        const dgRes = await axios.post(
          'https://api.deepgram.com/v1/listen?model=nova-2&language=es',
          { url: MediaUrl0 },
          { headers: { Authorization: `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const transcript = dgRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        if (transcript) textoUsuario = transcript;
        // Si no hay transcripción (sin saldo), avisar al cliente
        if (!textoUsuario) {
          textoUsuario = '';
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'user', contenido: '[Audio no transcrito]' },
            { telefono: userPhone, rol: 'assistant', contenido: 'No pude escuchar bien tu mensaje de voz. ¿Me lo escribes? 🌸' },
          ]);
          res.setHeader('Content-Type', 'text/xml');
          return res.status(200).send('<Response><Message>No pude escuchar bien tu mensaje de voz. ¿Me lo escribes? 🌸</Message></Response>');
        }
      } catch (err) {
        console.error('Deepgram:', err.message);
        // Sin crédito o error: pedir que escriban
        await supabase.from('conversaciones').insert([
          { telefono: userPhone, rol: 'user', contenido: '[Audio - error transcripción]' },
          { telefono: userPhone, rol: 'assistant', contenido: 'No pude escuchar tu audio en este momento. ¿Me escribes lo que necesitas? 🌸' },
        ]);
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send('<Response><Message>No pude escuchar tu audio en este momento. ¿Me escribes lo que necesitas? 🌸</Message></Response>');
      }
    }

    // ── 2. Carga paralela de datos ────────────────────────────
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
    const servicios     = serviciosRes.data     || [];
    const historial     = (historialRes.data    || []).reverse();

    const esNuevo = !cliente?.nombre || cliente.nombre.trim() === '';

    const hoy          = getFechaEcuador(0);
    const manana       = getFechaEcuador(1);
    const pasadoManana = getFechaEcuador(2);

    const yaSePidieronDatos = esNuevo && historial.some(
      m => m.rol === 'assistant' &&
           (m.contenido.toLowerCase().includes('nombre') || m.contenido.toLowerCase().includes('registr'))
    );

    // ── 3. Detectar oferta de lista de espera pendiente ───────
    const ultimoSystem = [...historial].reverse().find(m => m.rol === 'system')?.contenido || '';
    const esRespuestaListaEspera =
      ultimoSystem.startsWith('LISTA_ESPERA_OFERTA:') &&
      /^s[ií]|dale|ok|confirmo|perfecto|agéndalo/i.test(textoUsuario.trim());

    // ── 4. Catálogos para el prompt ───────────────────────────
    const catalogoEsps = especialistas
      .map(e => `- ${e.nombre}${e.expertise ? ` (${e.expertise})` : ''}${e.rol ? ` — ${e.rol}` : ''}`)
      .join('\n') || '(consultar con recepción)';

    const catalogoSvcs = servicios
      .map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion} min${s.categoria ? ` [${s.categoria}]` : ''}${s.descripcion_voda ? ` — ${s.descripcion_voda}` : ''}`)
      .join('\n') || '(consultar con recepción)';

    // ── 5. Resolver fecha desde texto del usuario ─────────────
    // IMPORTANTE: esto se hace AQUÍ, con 'servicios' ya definido
    const tLower = (textoUsuario || '').toLowerCase();
    let fechaFinal = manana;
    if      (tLower.includes('hoy'))           fechaFinal = hoy;
    else if (tLower.includes('pasado mañana')) fechaFinal = pasadoManana;
    else if (tLower.includes('mañana'))        fechaFinal = manana;
    else {
      const diasSemana = ['lunes','martes','miércoles','miercoles','jueves','viernes','sábado','sabado'];
      for (const dia of diasSemana) {
        if (tLower.includes(dia)) {
          const resuelta = resolverDiaSemana(dia);
          if (resuelta) { fechaFinal = resuelta; break; }
        }
      }
    }

    // Parsear hora natural del texto (para fallback si el LLM no extrae bien)
    const horaDetectadaTexto = parsearHoraNatural(textoUsuario);

    // ── 6. System prompt ─────────────────────────────────────
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
  ? `⚠️ CLIENTE NUEVO — número no registrado.
FLUJO OBLIGATORIO:
1. Saluda y preséntate como Aura de AuraSync.
2. En el MISMO mensaje pide JUNTOS: nombre y apellido + fecha de nacimiento (dd/mm/aaaa).
   Ejemplo: "¡Hola! 🌸 Soy Aura de AuraSync, encantada. Para registrarte necesito tu *nombre y apellido* y *fecha de nacimiento* (dd/mm/aaaa). ¿Me los compartes?"
3. Cuando el cliente responda → accion "registrar".
4. Confirma el registro y pregunta en qué puedes ayudar.
${yaSePidieronDatos ? 'NOTA: Ya se pidieron los datos. Si el cliente responde ahora, extrae y registra.' : ''}`
  : `✅ CLIENTE REGISTRADO — ${cliente.nombre} ${cliente.apellido || ''}. No pidas datos que ya tenemos.`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSONALIDAD Y TONO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Mensajes cortos como WhatsApp real. Máximo 2–3 oraciones, salvo confirmaciones.
- Varía aperturas y cierres. NUNCA repitas la misma frase dos veces seguidas.
- Emojis moderados: 🌸 ✨ 💫 📅. Máximo 1–2 por mensaje.
- NUNCA uses: "¡Con gusto!", "¡Claro que sí!", "Como asistente...", "Entendido".
- Si preguntan si eres humana: responde ambiguamente. Ej: "Soy Aura 😊, aquí para ayudarte."
- Sin cupo: sé directa y propositiva, sin dramatizar.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FLUJO DE AGENDAMIENTO — UN PASO POR MENSAJE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Paso 1 — Servicio: Pregunta SOLO si el cliente no lo dijo.
Paso 2 — Especialistas: SIEMPRE presenta MÍNIMO 2 con su expertise.
  "Para [servicio] te puedo ofrecer:
  • *[Nombre 1]* — [expertise]
  • *[Nombre 2]* — [expertise]
  ¿Con quién te gustaría?"
  Si solo hay 1: "Para esa hora tengo a *[Nombre]*. ¿Te funciona?"
  Si no hay ninguno: "Para esa hora todos están ocupados. ¿Te funciona otro horario?"
Paso 3 — Fecha/hora: Si el cliente ya la dijo, confírmaLA. No preguntes de nuevo.
Paso 4 — Confirmación: espera "sí", "dale", "ok", "agéndalo", "perfecto", "va", "confirmo".
Paso 5 — Ejecución: accion "agendar". SOLO tras confirmación explícita.

ANTI-REDUNDANCIA:
• Si dijo "a las 17:00" → confirma directamente, nunca vuelvas a preguntar.
• Si eligió especialista → no vuelvas a preguntar "¿con [nombre]?".
• Máximo 4 intercambios antes de la confirmación.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REAGENDAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Muestra PRIMERO las citas del cliente con formato numerado.
2. Cuando indique cuál → propón nueva fecha/hora.
3. Cuando confirme → accion "reagendar".
OBLIGATORIO: incluir cita_fecha_original (YYYY-MM-DD) y cita_hora_original (HH:MM).
NUNCA cambies el servicio. NUNCA inventes la fecha/hora original.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CANCELAR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Confirma cuál cita. 2. Pide "sí". 3. accion "cancelar".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LISTA DE ESPERA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sin cupo + cliente quiere esperar → accion "lista_espera".
"Te anoto y te aviso en cuanto se libere un lugar. 💫"

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
  "accion": "none"|"registrar"|"agendar"|"cancelar"|"reagendar"|"lista_espera",
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
REGLAS DEL JSON:
• "cita_hora" en formato 24h HH:MM (ej: "17:00", "09:30").
• "agendar" SOLO tras confirmación explícita.
• "reagendar" SOLO tras confirmar nueva fecha/hora. Siempre incluir originales.
• "cancelar" SOLO tras confirmación explícita.
• "registrar" cuando el cliente dé nombre+apellido+fecha nacimiento.
• "lista_espera" cuando no hay cupo y el cliente quiere esperar.
• "none" en todo lo demás. Campos sin valor → "".`;

    // ── 7. Llamada a OpenAI ───────────────────────────────────
    const messages = [{ role: 'system', content: systemPrompt }];
    historial
      .filter(m => m.rol === 'user' || m.rol === 'assistant')
      .forEach(m => messages.push({ role: m.rol === 'assistant' ? 'assistant' : 'user', content: m.contenido }));
    messages.push({ role: 'user', content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o', messages, temperature: 0.2, max_tokens: 500,
    }, { headers: { Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` }, timeout: 25000 });

    const fullReply = aiRes.data.choices[0].message.content;

    // ── 8. Extraer DATA_JSON ──────────────────────────────────
    let datos = {};
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?"accion"[\s\S]*?\})/i);
    if (jsonMatch) {
      try { datos = JSON.parse(jsonMatch[1].trim()); }
      catch (e) { console.error('JSON parse error:', e.message); }
    }

    // ── 9. Post-procesar datos ────────────────────────────────
    // Si el LLM no extrajo la hora pero la detectamos del texto, inyectarla
    if (!datos.cita_hora?.match(/^\d{2}:\d{2}$/) && horaDetectadaTexto) {
      datos.cita_hora = horaDetectadaTexto;
    }
    // Si el LLM puso fecha válida, sobrescribir fechaFinal
    if (datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/)) {
      fechaFinal = datos.cita_fecha;
    }

    const accion        = datos.accion || 'none';
    let cleanReply      = fullReply.replace(/DATA_JSON[\s\S]*$/i, '').trim();
    let mensajeAccion   = '';
    let accionEjecutada = false;

    // ════════════════════════════════════════════════════════
    // ACCIÓN 0 — Respuesta a oferta de lista de espera
    // ════════════════════════════════════════════════════════
    if (esRespuestaListaEspera) {
      try {
        const oferta     = JSON.parse(ultimoSystem.replace('LISTA_ESPERA_OFERTA:', ''));
        const svcData    = servicios.find(s => s.nombre === oferta.servicio);
        const disponible = await verificarDisponibilidad(oferta.fecha, oferta.hora, null, svcData?.duracion || 60);

        if (!disponible.ok) {
          mensajeAccion = 'Ese horario ya fue tomado. ¿Quieres que busque otra opción? 🌸';
        } else if (cliente?.id) {
          const recomendados  = await especialistasDisponibles(oferta.fecha, oferta.hora, svcData?.duracion || 60, especialistas);
          const espAsignado   = recomendados[0] || null;
          const { data: citaSupa, error: insErr } = await supabase.from('citas').insert({
            cliente_id: cliente.id, servicio_id: svcData?.id || null,
            especialista_id: espAsignado?.id || null,
            fecha_hora: `${oferta.fecha}T${oferta.hora}:00-05:00`,
            estado: 'Confirmada',
            nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
            servicio_aux: oferta.servicio, duracion_aux: svcData?.duracion || 60,
          }).select().single();

          if (!insErr) {
            await crearCitaAirtable({
              telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
              fecha: oferta.fecha, hora: oferta.hora, servicio: oferta.servicio,
              especialista: espAsignado?.nombre || 'Asignar',
              precio: svcData?.precio || 0, duracion: svcData?.duracion || 60,
              supabase_id: citaSupa.id, email: cliente.email,
              notas: cliente.notas_bienestar, observaciones: 'Confirmada desde lista de espera',
            });
            if (oferta.listaEsperaId) await supabase.from('lista_espera').update({ estado: 'Confirmada' }).eq('id', oferta.listaEsperaId);
            mensajeAccion = `✨ ¡Perfecto! Tu cita fue confirmada:\n📅 ${formatearFecha(oferta.fecha)}\n⏰ ${formatearHora(oferta.hora)}\n💇‍♀️ ${oferta.servicio}${espAsignado ? ` con ${espAsignado.nombre}` : ''}\n\n¡Te esperamos! 🌸`;
          } else {
            mensajeAccion = 'Tuve un problema guardando la cita. ¿Lo intentamos de nuevo? 🙏';
          }
        }
        accionEjecutada = true;
      } catch (err) { console.error('Lista espera respuesta:', err.message); }
    }

    // ════════════════════════════════════════════════════════
    // ACCIÓN 1 — Registrar cliente nuevo
    // ════════════════════════════════════════════════════════
    if (!accionEjecutada && accion === 'registrar' && esNuevo) {
      const nombre      = (datos.nombre   || '').trim();
      const apellido    = (datos.apellido || '').trim();
      const fechaNacISO = validarFechaNacimiento(datos.fecha_nacimiento || '');

      if (!nombre || !apellido) {
        mensajeAccion = 'Necesito tu *nombre y apellido* completos para registrarte. 🌸';
      } else if (!fechaNacISO) {
        mensajeAccion = 'La fecha de nacimiento no es válida. Compártela en formato *dd/mm/aaaa*. Ej: 15/03/1990 🌸';
      } else {
        const { data: nuevoCli, error: insErr } = await supabase
          .from('clientes').insert({ telefono: userPhone, nombre, apellido, fecha_nacimiento: fechaNacISO })
          .select().single();
        if (insErr?.code === '23505') {
          const { data: updCli, error: updErr } = await supabase
            .from('clientes').update({ nombre, apellido, fecha_nacimiento: fechaNacISO })
            .eq('telefono', userPhone).select().single();
          cliente       = updErr ? cliente : updCli;
          mensajeAccion = updErr ? 'Tuve un problema registrando tus datos. ¿Lo intentamos de nuevo? 🙏' : `¡Listo, ${nombre}! 🌸 Ya estás en AuraSync. ¿En qué puedo ayudarte?`;
        } else if (insErr) {
          console.error('Registrar:', insErr);
          mensajeAccion = 'Tuve un problema registrando tus datos. ¿Lo intentamos de nuevo? 🙏';
        } else {
          cliente       = nuevoCli;
          mensajeAccion = `¡Listo, ${nombre}! 🌸 Ya estás en AuraSync. ¿En qué puedo ayudarte?`;
        }
      }
      accionEjecutada = true;
    }

    // ════════════════════════════════════════════════════════
    // ACCIÓN 2 — Agendar
    // ════════════════════════════════════════════════════════
    if (!accionEjecutada && accion === 'agendar') {
      if (esNuevo && !cliente?.id) {
        mensajeAccion = 'Primero necesito registrarte. ¿Me compartes tu *nombre, apellido* y *fecha de nacimiento* (dd/mm/aaaa)? 🌸';
        accionEjecutada = true;
      } else if (!datos.cita_hora?.match(/^\d{2}:\d{2}$/)) {
        mensajeAccion = '¿A qué hora te funciona? (entre 9:00 a.m. y 6:00 p.m.) 🕐';
        accionEjecutada = true;
      } else if (!esDiaLaborable(fechaFinal)) {
        mensajeAccion = 'Los domingos no atendemos. ¿Te funciona otro día? 📅';
        accionEjecutada = true;
      } else {
        // Resolver servicio
        const svcData = servicios.find(s => s.nombre.toLowerCase() === (datos.cita_servicio || '').toLowerCase())
          || servicios.find(s => s.nombre.toLowerCase().includes((datos.cita_servicio || '').toLowerCase()))
          || { id: null, nombre: datos.cita_servicio || 'Servicio', precio: 0, duracion: 60 };

        // Resolver especialista con rotación equitativa
        const recomendados = await especialistasDisponibles(fechaFinal, datos.cita_hora, svcData.duracion, especialistas);
        let espData = null;
        if (datos.cita_especialista) {
          espData = especialistas.find(e => e.nombre.toLowerCase() === datos.cita_especialista.toLowerCase())
            || especialistas.find(e => e.nombre.toLowerCase().includes(datos.cita_especialista.toLowerCase()))
            || recomendados[0] || null;
        } else {
          espData = recomendados[0] || null;
        }

        const disponible = await verificarDisponibilidad(fechaFinal, datos.cita_hora, espData?.nombre || null, svcData.duracion);

        if (!disponible.ok) {
          const slots = await buscarSlotsLibres(fechaFinal, datos.cita_hora, svcData.duracion, espData?.nombre || null);
          if (slots.length) {
            mensajeAccion = `${disponible.mensaje}\n\nTengo disponible:\n${slots.map(s => `• ${formatearHora(s)}`).join('\n')}\n\n¿Cuál te funciona? 🌸`;
          } else {
            const otro = recomendados.find(e => e.id !== espData?.id);
            mensajeAccion = otro
              ? `${disponible.mensaje}\n\n¿Te parece con *${otro.nombre}* a la misma hora? ✨`
              : `${disponible.mensaje} Ese día ya no hay cupos. ¿Probamos otro día? 📅`;
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
            console.log('✅ Cita creada Supabase ID:', citaSupa.id);
            const atRes = await crearCitaAirtable({
              telefono: userPhone, nombre: datos.nombre || cliente?.nombre || '',
              apellido: datos.apellido || cliente?.apellido || '',
              fecha: fechaFinal, hora: datos.cita_hora, servicio: svcData.nombre,
              especialista: espNombre, precio: svcData.precio, duracion: svcData.duracion,
              supabase_id: citaSupa.id, email: cliente?.email || null,
              notas: cliente?.notas_bienestar || null, observaciones: 'Agendada por Aura',
            });
            mensajeAccion = atRes.ok
              ? `✨ ¡Listo! Tu cita está confirmada:\n📅 ${formatearFecha(fechaFinal)}\n⏰ ${formatearHora(datos.cita_hora)}\n💇‍♀️ ${svcData.nombre} con ${espNombre}\n💰 $${svcData.precio}\n\nTe esperamos con mucho cariño. 🌸`
              : `✅ Tu cita está guardada:\n📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(datos.cita_hora)}\n💇‍♀️ ${svcData.nombre} con ${espNombre}`;
          }
          accionEjecutada = true;
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // ACCIÓN 3 — Reagendar
    // ════════════════════════════════════════════════════════
    if (!accionEjecutada && accion === 'reagendar') {
      if (!datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/) || !datos.cita_hora?.match(/^\d{2}:\d{2}$/)) {
        mensajeAccion = '¿Para qué fecha y hora quieres mover la cita? (ej: mañana a las 3 p.m.) 📅';
        accionEjecutada = true;
      } else if (!esDiaLaborable(datos.cita_fecha)) {
        mensajeAccion = 'Los domingos no atendemos. ¿Te funciona otro día? 📅';
        accionEjecutada = true;
      } else {
        const clienteId  = cliente?.id;
        const nomCliente = cliente?.nombre   || '';
        const apeCliente = cliente?.apellido || '';

        let todasCitas = [];
        if (clienteId) {
          const { data: c1 } = await supabase.from('citas')
            .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
            .eq('cliente_id', clienteId).in('estado', ['Confirmada','Pendiente'])
            .order('fecha_hora', { ascending: true }).limit(10);
          if (c1?.length) todasCitas = c1;
        }
        if (!todasCitas.length && (nomCliente || apeCliente)) {
          const { data: c2 } = await supabase.from('citas')
            .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
            .ilike('nombre_cliente_aux', `%${`${nomCliente} ${apeCliente}`.trim()}%`)
            .in('estado', ['Confirmada','Pendiente'])
            .order('fecha_hora', { ascending: true }).limit(10);
          if (c2?.length) todasCitas = c2;
        }

        if (!todasCitas.length) {
          mensajeAccion = 'No encontré citas confirmadas a tu nombre. ¿Quieres agendar una nueva? 💫';
          accionEjecutada = true;
        } else {
          const mapaEsp = {};
          especialistas.forEach(e => { mapaEsp[e.id] = e.nombre; });
          todasCitas = todasCitas.map(c => ({ ...c, espNombre: mapaEsp[c.especialista_id] || 'Asignar' }));

          // Identificar cuál cita mover (4 estrategias)
          let citaAMover = null;
          // A: fecha+hora originales del JSON
          if (datos.cita_fecha_original && datos.cita_hora_original) {
            citaAMover = todasCitas.find(c =>
              c.fecha_hora?.split('T')[0] === datos.cita_fecha_original &&
              c.fecha_hora?.substring(11, 16) === datos.cita_hora_original
            );
          }
          // B: servicio
          if (!citaAMover && datos.cita_servicio) {
            citaAMover = todasCitas.find(c => c.servicio_aux?.toLowerCase().includes(datos.cita_servicio.toLowerCase()));
          }
          // C: texto del usuario
          if (!citaAMover) {
            let fMenc = null;
            if      (tLower.includes('hoy'))           fMenc = hoy;
            else if (tLower.includes('pasado mañana')) fMenc = pasadoManana;
            else if (tLower.includes('mañana'))        fMenc = manana;
            const horaM = textoUsuario.match(/(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:am|pm|a\.m\.|p\.m\.)?/i);
            if (horaM && fMenc) {
              let hh = parseInt(horaM[1], 10);
              const mm = horaM[2] ? parseInt(horaM[2], 10) : 0;
              if (/pm|p\.m\./i.test(horaM[0]) && hh < 12) hh += 12;
              const hMenc = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'00')}`;
              citaAMover = todasCitas.find(c => c.fecha_hora?.split('T')[0] === fMenc && c.fecha_hora?.substring(11,16) === hMenc);
            } else if (fMenc) {
              const mismaFecha = todasCitas.filter(c => c.fecha_hora?.split('T')[0] === fMenc);
              if (mismaFecha.length === 1) citaAMover = mismaFecha[0];
            }
          }
          // D: única cita
          if (!citaAMover && todasCitas.length === 1) citaAMover = todasCitas[0];

          if (!citaAMover) {
            const lista = todasCitas.map((c, i) =>
              `${i+1}. *${c.servicio_aux}* — ${formatearFecha(c.fecha_hora?.split('T')[0])} a las ${formatearHora(c.fecha_hora?.substring(11,16))} con ${c.espNombre}`
            ).join('\n');
            mensajeAccion = `Veo que tienes ${todasCitas.length} citas:\n${lista}\n\n¿Cuál quieres mover? 💫`;
            accionEjecutada = true;
          } else {
            const svcActual = servicios.find(s => s.id === citaAMover.servicio_id)
              || { id: null, nombre: citaAMover.servicio_aux, precio: 0, duracion: citaAMover.duracion_aux || 60 };
            const espOrigNombre  = citaAMover.espNombre;
            const espOrigId      = citaAMover.especialista_id;
            let   espFinalNombre = espOrigNombre;
            let   espFinalId     = espOrigId;
            if (datos.cita_especialista) {
              const nuevoEsp = especialistas.find(e => e.nombre.toLowerCase() === datos.cita_especialista.toLowerCase());
              if (nuevoEsp) { espFinalNombre = nuevoEsp.nombre; espFinalId = nuevoEsp.id; }
            }
            const fechaNueva = datos.cita_fecha;
            const horaNueva  = datos.cita_hora;
            const fechaAntes = citaAMover.fecha_hora?.split('T')[0];
            const horaAntes  = citaAMover.fecha_hora?.substring(11, 16);

            const disponible = await verificarDisponibilidad(fechaNueva, horaNueva, espFinalNombre, svcActual.duracion, citaAMover.id);
            if (!disponible.ok) {
              const slots = await buscarSlotsLibres(fechaNueva, horaNueva, svcActual.duracion, espFinalNombre, citaAMover.id);
              mensajeAccion = slots.length
                ? `${disponible.mensaje}\n\nTengo disponible:\n${slots.map(s=>`• ${formatearHora(s)}`).join('\n')}\n\n¿Cuál te funciona? 🌸`
                : `${disponible.mensaje} Ese día ya no hay cupos. ¿Probamos otro día? 📅`;
              accionEjecutada = true;
            } else {
              const { data: updData, error: updErr } = await supabase.from('citas')
                .update({
                  fecha_hora: `${fechaNueva}T${horaNueva}:00-05:00`, estado: 'Confirmada',
                  especialista_id: espFinalId,
                  nombre_cliente_aux: `${nomCliente} ${apeCliente}`.trim(),
                  servicio_id: citaAMover.servicio_id, servicio_aux: citaAMover.servicio_aux,
                  duracion_aux: citaAMover.duracion_aux,
                }).eq('id', citaAMover.id).select();

              if (updErr || !updData?.length) {
                console.error('Reagendar Supabase:', updErr);
                mensajeAccion = 'Tuve un problema moviendo tu cita. ¿Lo intentamos de nuevo? 🙏';
              } else {
                const atRes = await actualizarCitaAirtable(citaAMover.id, {
                  fecha: fechaNueva, hora: horaNueva, especialista: espFinalNombre,
                  observaciones: `Reagendada de ${fechaAntes} ${horaAntes} → ${fechaNueva} ${horaNueva}`,
                  telefono: userPhone, fechaAnterior: fechaAntes, horaAnterior: horaAntes,
                  especialistaAnterior: espOrigNombre,
                });
                mensajeAccion = atRes.ok
                  ? `✨ ¡Cita movida!\n\nDe: ${formatearFecha(fechaAntes)} a las ${formatearHora(horaAntes)}\nA: 📅 ${formatearFecha(fechaNueva)} a las ${formatearHora(horaNueva)}\n💇‍♀️ ${svcActual.nombre} con ${espFinalNombre}\n\n¡Nos vemos pronto! 🌸`
                  : `✅ Tu cita fue movida a ${formatearFecha(fechaNueva)} a las ${formatearHora(horaNueva)} con ${espFinalNombre}. 🌸`;
              }
              accionEjecutada = true;
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════
    // ACCIÓN 4 — Cancelar
    // ════════════════════════════════════════════════════════
    if (!accionEjecutada && accion === 'cancelar') {
      let todasCitas = [];
      if (cliente?.id) {
        const { data: c1 } = await supabase.from('citas')
          .select('id, servicio_aux, fecha_hora, especialista_id, duracion_aux, servicio_id')
          .eq('cliente_id', cliente.id).in('estado', ['Confirmada','Pendiente'])
          .order('fecha_hora', { ascending: true }).limit(10);
        if (c1?.length) todasCitas = c1;
      }
      if (!todasCitas.length && cliente) {
        const nb = `${cliente.nombre || ''} ${cliente.apellido || ''}`.trim();
        if (nb) {
          const { data: c2 } = await supabase.from('citas')
            .select('id, servicio_aux, fecha_hora, especialista_id, duracion_aux, servicio_id')
            .ilike('nombre_cliente_aux', `%${nb}%`).in('estado', ['Confirmada','Pendiente'])
            .order('fecha_hora', { ascending: true }).limit(10);
          if (c2?.length) todasCitas = c2;
        }
      }
      const mapaEsp = {};
      especialistas.forEach(e => { mapaEsp[e.id] = e.nombre; });
      todasCitas = todasCitas.map(c => ({ ...c, espNombre: mapaEsp[c.especialista_id] || 'Asignar' }));

      let citaACancelar = todasCitas.length
        ? (datos.cita_servicio
            ? todasCitas.find(c => c.servicio_aux?.toLowerCase().includes(datos.cita_servicio.toLowerCase())) || todasCitas[0]
            : todasCitas[0])
        : null;

      if (!citaACancelar) {
        mensajeAccion = 'No encontré citas activas a tu nombre para cancelar. 🌸';
      } else {
        const fCita = citaACancelar.fecha_hora?.split('T')[0];
        const hCita = citaACancelar.fecha_hora?.substring(11, 16);
        const { error: cancelErr } = await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', citaACancelar.id);
        if (cancelErr) {
          console.error('Cancelar Supabase:', cancelErr);
          mensajeAccion = 'Tuve un problema cancelando tu cita. ¿Me das un momento? 🙏';
        } else {
          // Notificar lista de espera
          const enEspera = await notificarListaEspera(fCita, hCita, citaACancelar.especialista_id, citaACancelar.servicio_id);
          for (const e of enEspera) {
            await supabase.from('conversaciones').insert([
              { telefono: e.telefono, rol: 'assistant', contenido: `🌸 Hola ${e.nombre}, se liberó un cupo:\n📅 ${formatearFecha(fCita)}\n⏰ ${formatearHora(hCita)}${e.servicio ? `\n💇‍♀️ ${e.servicio}` : ''}\n\n¿Te lo confirmo? Responde *sí* y te lo reservo. ✨` },
              { telefono: e.telefono, rol: 'system', contenido: `LISTA_ESPERA_OFERTA:${JSON.stringify({ listaEsperaId: e.id, fecha: fCita, hora: hCita, servicio: e.servicio })}` },
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

    // ════════════════════════════════════════════════════════
    // ACCIÓN 5 — Lista de espera
    // ════════════════════════════════════════════════════════
    if (!accionEjecutada && accion === 'lista_espera' && cliente?.id) {
      const svcData = servicios.find(s => s.nombre.toLowerCase().includes((datos.cita_servicio || '').toLowerCase()));
      const espData = especialistas.find(e => e.nombre.toLowerCase().includes((datos.cita_especialista || '').toLowerCase()));
      const res = await agregarListaEspera(
        cliente.id, svcData?.id || null, datos.cita_servicio || 'Servicio',
        espData?.id || null, fechaFinal, datos.cita_hora || '10:00'
      );
      mensajeAccion = res.ok
        ? `Perfecto, te anoto en lista de espera para *${datos.cita_servicio || 'tu servicio'}* el ${formatearFecha(fechaFinal)}. En cuanto se libere un cupo te aviso. 💫`
        : 'Tuve un problemita anotándote. ¿Lo intentamos de nuevo? 🙏';
      accionEjecutada = true;
    }

    // ── Respuesta final ───────────────────────────────────────
    const respuestaFinal = (accionEjecutada && mensajeAccion) ? mensajeAccion : cleanReply;

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
