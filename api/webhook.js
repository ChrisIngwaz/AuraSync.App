import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER: process.env.TWILIO_NUMBER || '14155238886'
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
// TWILIO
// ═══════════════════════════════════════════════════════════════

async function enviarWhatsApp(to, body) {
  const sid = CONFIG.TWILIO_ACCOUNT_SID;
  const token = CONFIG.TWILIO_AUTH_TOKEN;
  const from = `whatsapp:${CONFIG.TWILIO_NUMBER}`;
  const toFinal = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const params = new URLSearchParams();
  params.append('To', toFinal);
  params.append('From', from);
  params.append('Body', body);

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      params.toString(),
      { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return { ok: true };
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
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
// MOTOR DE DISPONIBILIDAD REAL
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
    
    // <-- CORREGIDO: Manejo de error si falla la consulta de especialistas
    const { data: especialistasData, error: espError } = await supabase.from('especialistas').select('id, nombre');
    if (espError) { console.error('Error Supabase especialistas:', espError); return []; }
    
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
  try {
    // <-- CORREGIDO: Manejo de error si falla la consulta
    const { data: todosEspecialistas, error: espError } = await supabase
      .from('especialistas')
      .select('id, nombre, rol, expertise, local_id, activo')
      .eq('activo', true);

    if (espError || !todosEspecialistas?.length) return [];

    const citas = await obtenerCitasDelDia(fecha);
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracion || 60);

    const disponibles = todosEspecialistas.filter(esp => {
      const conflicto = hayConflictoHorario(inicioNuevo, finNuevo, citas, esp.nombre);
      return !conflicto.conflicto;
    });

    if (!disponibles.length) return [];

    const hoy = getFechaEcuador(0);
    const hace30Dias = getFechaEcuador(-30);
    const carga = await obtenerCargaEspecialistas(hace30Dias, hoy, disponibles.map(e => e.id));
    disponibles.sort((a, b) => (carga[a.id] || 0) - (carga[b.id] || 0));

    return disponibles;
  } catch (e) {
    console.error('Error obteniendo especialistas disponibles:', e);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// LISTA DE ESPERA
// ═══════════════════════════════════════════════════════════════

async function agregarAListaEspera(datos) {
  try {
    const { data, error } = await supabase
      .from('lista_espera')
      .insert({
        cliente_id: datos.cliente_id,
        telefono: datos.telefono,
        nombre_cliente: datos.nombre,
        fecha_solicitada: datos.fecha,
        hora_solicitada: datos.hora,
        servicio_id: datos.servicio_id,
        servicio_nombre: datos.servicio,
        especialista_preferido_id: datos.especialista_id,
        especialista_preferido_nombre: datos.especialista,
        estado: 'Pendiente',
        expira_en: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('❌ Error agregando a lista de espera:', e);
    return { ok: false, error: e.message };
  }
}

async function buscarYNotificarListaEspera(fecha, hora, duracion, servicioId) {
  try {
    const { data: candidatos } = await supabase
      .from('lista_espera')
      .select('*')
      .eq('estado', 'Pendiente')
      .eq('fecha_solicitada', fecha)
      .lte('hora_solicitada', hora)
      .gte('expira_en', new Date().toISOString())
      .order('orden', { ascending: true })
      .order('creado_en', { ascending: true })
      .limit(5);

    if (!candidatos?.length) return { notificados: 0 };

    let notificados = 0;
    for (const candidato of candidatos) {
      const disponible = await verificarDisponibilidad(fecha, hora, candidato.especialista_preferido_nombre, duracion);
      if (!disponible.ok) continue;

      const mensaje = `✨ *¡Buenas noticias, ${candidato.nombre_cliente || ''}!* ✨\n\n` +
        `Se liberó un cupo para *${candidato.servicio_nombre}* el *${formatearFecha(fecha)}* a las *${formatearHora(hora)}*.\n\n` +
        `¿Lo quieres? Responde *SÍ* en los próximos 15 minutos y te lo agendo. 🌸\n\n` +
        `_Si no respondes, pasaremos al siguiente de la lista._`;

      const envio = await enviarWhatsApp(candidato.telefono, mensaje);
      if (envio.ok) {
        await supabase.from('lista_espera')
          .update({ estado: 'Notificado', notificado_en: new Date().toISOString(), intentos_notificacion: candidato.intentos_notificacion + 1 })
          .eq('id', candidato.id);
        notificados++;
      }
    }

    return { notificados };
  } catch (e) {
    console.error('❌ Error notificando lista de espera:', e);
    return { notificados: 0, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// MÁQUINA DE ESTADOS (CORREGIDA - ahora recibe servicios y especialistas)
// ═══════════════════════════════════════════════════════════════

async function detectarEstado(historial, cliente, textoUsuario, hoy, manana, pasado, servicios = [], especialistas = []) {
  const t = textoUsuario.toLowerCase().trim();
  const ultimoAssistant = historial.filter(m => m.rol === 'assistant').pop()?.contenido?.toLowerCase() || '';

  const intencionReagendar = /reagendar|mover|cambiar|modificar/.test(t);
  const intencionCancelar = /cancelar|anular|eliminar/.test(t);
  const intencionAgendar = /agendar|reservar|pedir|quiero/.test(t) && !intencionReagendar && !intencionCancelar;

  if (!cliente?.nombre) return { estado: 'inicio', intencion: 'registro' };

  const ultimoSystem = historial.filter(m => m.rol === 'system').pop()?.contenido || '';
  if (ultimoSystem.includes('NOTIFICACION_LISTA_ESPERA')) {
    if (/^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va|bueno/.test(t)) {
      return { estado: 'confirmar_lista_espera', intencion: 'agendar' };
    }
    return { estado: 'rechazar_lista_espera', intencion: 'none' };
  }

  if (ultimoAssistant.includes('¿todo en orden') || ultimoAssistant.includes('¿confirmas')) {
    if (/^s[ií]|dale|ok|perfecto|confirmo|todo bien|súper/.test(t)) {
      return { estado: 'confirmar_recordatorio', intencion: 'confirmar' };
    }
    if (/no|cancelar|mover|reagendar|cambiar/.test(t)) {
      return { estado: 'reagendar_listar', intencion: 'reagendar' };
    }
  }

  if (ultimoAssistant.includes('¿te lo agendo') || ultimoAssistant.includes('¿confirmamos') || ultimoAssistant.includes('¿te parece')) {
    if (/^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va|bueno/.test(t)) {
      return { estado: 'confirmar_cita', intencion: 'agendar' };
    }
    if (/no|otro|diferente|cambiar|más tarde|más temprano/.test(t)) {
      return { estado: 'esperando_fecha_hora', intencion: 'agendar' };
    }
  }

  if (ultimoAssistant.includes('¿con quién te gustaría') || ultimoAssistant.includes('te puedo ofrecer a')) {
    const mencionaEspecialista = especialistas.some(e => t.includes(e.nombre.toLowerCase()));
    if (mencionaEspecialista || t.length < 20) {
      return { estado: 'esperando_fecha_hora', intencion: 'agendar' };
    }
  }

  if (ultimoAssistant.includes('¿qué día') || ultimoAssistant.includes('¿qué hora') || ultimoAssistant.includes('tengo disponible')) {
    return { estado: 'procesar_fecha_hora', intencion: 'agendar' };
  }

  if (intencionReagendar) return { estado: 'reagendar_listar', intencion: 'reagendar' };
  if (intencionCancelar) return { estado: 'cancelar_listar', intencion: 'cancelar' };

  const mencionaServicio = servicios.some(s => t.includes(s.nombre.toLowerCase()) || t.includes(s.categoria?.toLowerCase() || ''));
  if (mencionaServicio) return { estado: 'esperando_especialista', intencion: 'agendar' };

  return { estado: 'esperando_servicio', intencion: 'agendar' };
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
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

    if (esNuevo) {
      const yaPidioDatos = historial.some(m => m.rol === 'assistant' && /nombre.*apellido.*fecha/i.test(m.contenido));

      if (yaPidioDatos) {
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
      // <-- CORREGIDO: Ahora pasamos servicios y especialistas a detectarEstado
      const estadoDetectado = await detectarEstado(historial, cliente, textoUsuario, hoy, manana, pasadoManana, servicios, especialistas);
      console.log('🎯 Estado detectado:', estadoDetectado.estado, '| Intención:', estadoDetectado.intencion);

      if (estadoDetectado.estado === 'confirmar_lista_espera') {
        const notifMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('NOTIFICACION_LISTA_ESPERA:')).pop()?.contenido;
        if (notifMatch) {
          const datosNotif = JSON.parse(notifMatch.replace('NOTIFICACION_LISTA_ESPERA:', ''));
          const disponible = await verificarDisponibilidad(datosNotif.fecha, datosNotif.hora, datosNotif.especialista, datosNotif.duracion);
          if (!disponible.ok) {
            respuesta = "Lo siento, ese cupo ya fue tomado por otro cliente. Te mantengo en lista de espera por si se libera otro. 🌸";
          } else {
            const { data: citaSupabase, error: insertError } = await supabase
              .from('citas')
              .insert({
                cliente_id: cliente.id,
                servicio_id: datosNotif.servicio_id,
                especialista_id: datosNotif.especialista_id,
                fecha_hora: `${datosNotif.fecha}T${datosNotif.hora}:00-05:00`,
                estado: 'Confirmada',
                nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
                servicio_aux: datosNotif.servicio,
                duracion_aux: datosNotif.duracion
              })
              .select().single();

            if (!insertError) {
              await crearCitaAirtable({
                telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
                fecha: datosNotif.fecha, hora: datosNotif.hora,
                servicio: datosNotif.servicio, especialista: datosNotif.especialista,
                precio: datosNotif.precio, duracion: datosNotif.duracion,
                supabase_id: citaSupabase.id, email: cliente.email || null,
                notas: cliente.notas_bienestar || null, observaciones: 'Agendada desde lista de espera'
              });

              await supabase.from('lista_espera').update({ estado: 'Confirmado', cita_resultante_id: citaSupabase.id }).eq('id', datosNotif.lista_espera_id);

              respuesta = `✨ ¡Listo! Tu cita para *${datosNotif.servicio}* está confirmada:\n📅 ${formatearFecha(datosNotif.fecha)}\n⏰ ${formatearHora(datosNotif.hora)}\n💇‍♀️ Con ${datosNotif.especialista}\n💰 $${datosNotif.precio}\n\nTe esperamos con mucho cariño. 🌸`;
              accionBackend = 'agendar';
            }
          }
        }
      }

      else if (estadoDetectado.estado === 'rechazar_lista_espera') {
        respuesta = "Entendido. Te mantengo en lista de espera por si se libera otro cupo. 🌸";
      }

      else if (estadoDetectado.estado === 'confirmar_recordatorio') {
        const citaIdMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('RECORDATORIO_CITA_ID:')).pop()?.contenido;
        if (citaIdMatch) {
          const citaId = citaIdMatch.replace('RECORDATORIO_CITA_ID:', '');
          await supabase.from('citas')
            .update({ confirmacion_cliente: 'Confirmada', cliente_confirmo_en: new Date().toISOString() })
            .eq('id', citaId);
          respuesta = `¡Gracias por confirmar, ${cliente.nombre}! 🌸 Nos vemos en tu cita. Si algo cambia, solo avísame.`;
        }
      }

      else if (estadoDetectado.intencion === 'reagendar' || estadoDetectado.estado === 'reagendar_listar') {
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

          if (citasConfirmadas.length === 1) {
            const c = citasConfirmadas[0];
            const fecha = c.fecha_hora.split('T')[0];
            const hora = c.fecha_hora.substring(11, 16);
            respuesta = `Veo que tienes una cita de *${c.servicio_aux}* el *${formatearFecha(fecha)}* a las *${formatearHora(hora)}* con *${espMap[c.especialista_id] || 'Asignar'}*.\n\n¿Para qué fecha y hora la quieres mover? 📅`;
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

      else if (estadoDetectado.estado === 'confirmar_cita') {
        const propuestaMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('PROPUESTA_CITA:')).pop()?.contenido;

        if (!propuestaMatch) {
          respuesta = "Disculpa, no recordé los detalles de la cita que estábamos agendando. ¿Me los repites? 🌸";
        } else {
          const datosPropuesta = JSON.parse(propuestaMatch.replace('PROPUESTA_CITA:', ''));

          const disponible = await verificarDisponibilidad(
            datosPropuesta.fecha, datosPropuesta.hora, datosPropuesta.especialista, datosPropuesta.duracion
          );

          if (!disponible.ok) {
            const alternativa = await buscarAlternativa(
              datosPropuesta.fecha, datosPropuesta.hora, datosPropuesta.especialista, datosPropuesta.duracion
            );
            respuesta = `${disponible.mensaje} ${alternativa.mensaje}`;

            if (alternativa.hora) {
              datosPropuesta.hora = alternativa.hora;
              await supabase.from('conversaciones').insert([
                { telefono: userPhone, rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify(datosPropuesta)}` }
              ]);
            }
          } else {
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

      else if (estadoDetectado.estado === 'procesar_fecha_hora' || estadoDetectado.estado === 'esperando_fecha_hora') {
        let fecha = parsearFechaRelativa(textoUsuario, hoy, manana, pasadoManana);
        let hora = parsearHora(textoUsuario);

        if (!fecha) {
          const ultimaFechaMencionada = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('FECHA_PROPUESTA:')).pop()?.contenido;
          if (ultimaFechaMencionada) fecha = ultimaFechaMencionada.replace('FECHA_PROPUESTA:', '');
          else fecha = manana;
        }

        if (!hora) {
          respuesta = `¿A qué hora te funciona para el ${formatearFecha(fecha)}? Te sugiero entre 9:00 a.m. y 6:00 p.m. 🌸`;
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` }
          ]);
        } else {
          const servicioMencionado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('SERVICIO_SELECCIONADO:')).pop()?.contenido?.replace('SERVICIO_SELECCIONADO:', '');
          const servicioData = servicios?.find(s => s.nombre.toLowerCase() === (servicioMencionado || '').toLowerCase()) || servicios?.[0];

          let especialistaNombre = null;
          let especialistaId = null;

          for (const esp of (especialistas || [])) {
            if (textoUsuario.toLowerCase().includes(esp.nombre.toLowerCase())) {
              especialistaNombre = esp.nombre;
              especialistaId = esp.id;
              break;
            }
          }

          if (!especialistaNombre) {
            const ultimaEsp = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('ESPECIALISTA_PROPUESTO:')).pop()?.contenido?.replace('ESPECIALISTA_PROPUESTO:', '');
            if (ultimaEsp) {
              const espData = especialistas?.find(e => e.nombre === ultimaEsp);
              if (espData) { especialistaNombre = espData.nombre; especialistaId = espData.id; }
            }
          }

          if (!especialistaNombre) {
            const disponibles = await obtenerEspecialistasDisponibles(fecha, hora, servicioData?.duracion || 60);
            if (disponibles.length === 0) {
              const alternativa = await buscarAlternativa(fecha, hora, null, servicioData?.duracion || 60);
              if (alternativa.hora) {
                respuesta = `Ese horario está completo. ${alternativa.mensaje}\n\nO si prefieres, te puedo poner en *lista de espera* por si alguien cancela. ¿Te interesa? 🌸`;
                await supabase.from('conversaciones').insert([
                  { telefono: userPhone, rol: 'system', contenido: `LISTA_ESPERA_PROPUESTA:${JSON.stringify({
                    fecha, hora, servicio: servicioData?.nombre, servicio_id: servicioData?.id,
                    precio: servicioData?.precio, duracion: servicioData?.duracion
                  })}` }
                ]);
              } else {
                respuesta = `Ese día ya no tenemos cupos disponibles. ¿Te parece otro día? 📅\n\nO te puedo poner en lista de espera por si se libera algo.`;
              }
            } else {
              const topEspecialistas = disponibles.slice(0, 3);
              const lista = topEspecialistas.map(e => `• *${e.nombre}* — ${e.expertise || e.rol || 'Especialista'}`).join('\n');
              respuesta = `Para ${servicioData?.nombre || 'tu servicio'} a las ${formatearHora(hora)} del ${formatearFecha(fecha)} tengo disponible a:\n${lista}\n\n¿Con quién te gustaría? ✨`;

              await supabase.from('conversaciones').insert([
                { telefono: userPhone, rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData?.nombre}` },
                { telefono: userPhone, rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` },
                { telefono: userPhone, rol: 'system', contenido: `HORA_PROPUESTA:${hora}` }
              ]);
            }
          } else {
            const disponible = await verificarDisponibilidad(fecha, hora, especialistaNombre, servicioData?.duracion || 60);

            if (!disponible.ok) {
              const alternativa = await buscarAlternativa(fecha, hora, especialistaNombre, servicioData?.duracion || 60);
              respuesta = `${disponible.mensaje} ${alternativa.mensaje}`;
              if (alternativa.hora) {
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

      else if (estadoDetectado.estado === 'esperando_especialista') {
        let servicioData = null;
        for (const s of (servicios || [])) {
          if (textoUsuario.toLowerCase().includes(s.nombre.toLowerCase()) || 
              textoUsuario.toLowerCase().includes(s.categoria?.toLowerCase() || '')) {
            servicioData = s;
            break;
          }
        }

        if (!servicioData) {
          const servicioGuardado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('SERVICIO_SELECCIONADO:')).pop()?.contenido?.replace('SERVICIO_SELECCIONADO:', '');
          servicioData = servicios?.find(s => s.nombre === servicioGuardado);
        }

        if (!servicioData) {
          const listaServicios = (servicios || []).map(s => `• *${s.nombre}* — $${s.precio}, ${s.duracion} min`).join('\n');
          respuesta = `Estos son nuestros servicios disponibles:\n${listaServicios}\n\n¿Cuál te gustaría agendar? 🌸`;
        } else {
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData.nombre}` }
          ]);
          respuesta = `Excelente elección. *${servicioData.nombre}* — $${servicioData.precio}, ${servicioData.duracion} minutos.\n\n¿Para qué día y hora te funciona? 📅`;
        }
      }

      else if (historial.some(m => m.rol === 'system' && m.contenido.startsWith('LISTA_ESPERA_PROPUESTA:'))) {
        const propuestaLE = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('LISTA_ESPERA_PROPUESTA:')).pop()?.contenido;
        if (propuestaLE && /^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va|bueno/.test(textoUsuario.toLowerCase())) {
          const datosLE = JSON.parse(propuestaLE.replace('LISTA_ESPERA_PROPUESTA:', ''));
          const resultado = await agregarAListaEspera({
            cliente_id: cliente.id,
            telefono: userPhone,
            nombre: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
            fecha: datosLE.fecha,
            hora: datosLE.hora,
            servicio_id: datosLE.servicio_id,
            servicio: datosLE.servicio,
            especialista_id: null,
            especialista: null
          });
          if (resultado.ok) {
            respuesta = `✨ ¡Listo! Te agregué a la lista de espera para *${datosLE.servicio}* el *${formatearFecha(datosLE.fecha)}* a las *${formatearHora(datosLE.hora)}*.\n\nSi alguien cancela, te aviso al instante. 🌸`;
          } else {
            respuesta = "Tuve un problema agregándote a la lista de espera. ¿Lo intentamos de nuevo? 🙏";
          }
        } else {
          respuesta = "Entendido. Si cambias de opinión, solo dime y te agrego a la lista de espera. 🌸";
        }
      }

      else {
        respuesta = `¡Hola ${cliente.nombre}! 🌸 Soy Aura. ¿Qué servicio te gustaría agendar hoy?`;
        if (servicios?.length) {
          const populares = servicios.slice(0, 3).map(s => `*${s.nombre}* ($${s.precio})`).join(', ');
          respuesta += ` Tenemos ${populares}...`;
        }
      }
    }

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
