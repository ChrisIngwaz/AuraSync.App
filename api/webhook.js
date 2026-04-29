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
// SYSTEM PROMPT DE AURA
// ═══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `Eres Aura, la coordinadora de AuraSync. No eres un robot. Eres la recepcionista perfecta de una cadena de spas de belleza: cálida, eficiente, con memoria de elefante y un toque de humor suave.

REGLAS DE ORO:
1. HABLA COMO UNA AMIGA: "¿Qué te hago hoy, amor?" NO "Seleccione servicio"
2. UN SOLO PASO POR MENSAJE: Nunca combines saludo + servicio + hora + especialista
3. USA LOS DATOS REALES DEL CONTEXTO: Nunca inventes nombres, precios ni horarios
4. SIEMPRE USA NOMBRE DEL CLIENTE cuando lo sepas
5. EMOJIS CON MODERACIÓN: 🌸 ✨ 💫 (nunca más de 2 por mensaje)
6. SI HAY CONFLICTO DE HORARIO: "Uy, María ya está ocupada a esa hora con un tinte. ¿Qué tal a las 4:30? Ella es una genia con el corte."
7. SI EL CLIENTE DICE "CUALQUIERA": Asigna por rotación sin preguntar más
8. NUNCA PIDAS DATOS QUE YA TENGAS
9. SI ES CLIENTE NUEVO: Pide nombre, apellido y fecha de nacimiento (dd/mm/aaaa)
10. SI ES CLIENTE REGISTRADO: Saluda por nombre y pregunta qué servicio quiere

TONO POR ESTADO:
- Registro: Cálido, paciente, bienvenida
- Agendando: Eficiente, una pregunta a la vez
- Confirmando: Entusiasta, celebratorio
- Error: "Ups, déjame revisar un segundito 🌸" (nunca técnico)
- Lista de espera: Esperanzado, "te aviso al toque"`;

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
// OPENAI - GENERADOR DE RESPUESTAS HUMANAS
// ═══════════════════════════════════════════════════════════════

async function generarRespuestaAura(contexto, historial) {
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historial.slice(-10).map(m => ({
        role: m.rol === 'assistant' ? 'assistant' : 'user',
        content: m.contenido
      })),
      {
        role: 'user',
        content: `CONTEXTO DEL SISTEMA (usar estos datos exactos, nunca inventar):\n${JSON.stringify(contexto, null, 2)}\n\nGenera la respuesta de Aura. Un solo paso. Máximo 2-3 oraciones.`
      }
    ];

    const aiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.5,
        max_tokens: 200
      },
      {
        headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
        timeout: 10000
      }
    );

    return aiRes.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('❌ Error OpenAI:', error.message);
    // Fallback: respuesta genérica pero humana
    return 'Ups, déjame revisar un segundito 🌸';
  }
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
          "Local": datos.local || '',
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

async function cancelarCitaAirtable(supabaseId, datosFallback) {
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
          "Observaciones de confirmación": "Cancelada por cliente vía WhatsApp"
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

async function obtenerCitasDelDia(fecha, localId, excluirCitaId = null) {
  try {
    const inicioDia = `${fecha}T00:00:00`;
    const finDia = `${fecha}T23:59:59`;
    let query = supabase
      .from('citas')
      .select('id, fecha_hora, especialista_id, duracion_aux, servicio_aux, estado, nombre_cliente_aux, cliente_id')
      .eq('estado', 'Confirmada')
      .eq('local_id', localId)
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);
    if (excluirCitaId) query = query.neq('id', excluirCitaId);
    const { data: citasSupabase, error: supaError } = await query;
    if (supaError) { console.error('Error Supabase citas:', supaError); return []; }
    
    const { data: especialistasData, error: espError } = await supabase.from('especialistas').select('id, nombre').eq('local_id', localId);
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

async function obtenerCargaEspecialistas(fechaInicio, fechaFin, especialistasIds, localId) {
  try {
    const { data: citas } = await supabase
      .from('citas')
      .select('especialista_id, estado')
      .eq('estado', 'Confirmada')
      .eq('local_id', localId)
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

async function verificarDisponibilidad(fecha, hora, especialistaSolicitado, duracionMinutos, localId, excluirCitaId = null) {
  const citas = await obtenerCitasDelDia(fecha, localId, excluirCitaId);
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

async function buscarAlternativa(fecha, horaSolicitada, especialistaSolicitado, duracion, localId, excluirCitaId = null) {
  const citas = await obtenerCitasDelDia(fecha, localId, excluirCitaId);
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

async function obtenerEspecialistasDisponibles(fecha, hora, duracion, localId, servicioCategoria = null) {
  try {
    const { data: todosEspecialistas, error: espError } = await supabase
      .from('especialistas')
      .select('id, nombre, rol, expertise, local_id, activo')
      .eq('activo', true)
      .eq('local_id', localId);

    if (espError || !todosEspecialistas?.length) return [];

    const citas = await obtenerCitasDelDia(fecha, localId);
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
    const carga = await obtenerCargaEspecialistas(hace30Dias, hoy, disponibles.map(e => e.id), localId);
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
        local_id: datos.local_id,
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

async function buscarYNotificarListaEspera(fecha, hora, duracion, localId, servicioId) {
  try {
    const { data: candidatos } = await supabase
      .from('lista_espera')
      .select('*')
      .eq('estado', 'Pendiente')
      .eq('local_id', localId)
      .eq('fecha_solicitada', fecha)
      .lte('hora_solicitada', hora)
      .gte('expira_en', new Date().toISOString())
      .order('orden', { ascending: true })
      .order('creado_en', { ascending: true })
      .limit(5);

    if (!candidatos?.length) return { notificados: 0 };

    let notificados = 0;
    for (const candidato of candidatos) {
      const disponible = await verificarDisponibilidad(fecha, hora, candidato.especialista_preferido_nombre, duracion, localId);
      if (!disponible.ok) continue;

      const mensaje = `✨ *¡Buenas noticias, ${candidato.nombre_cliente || ''}!* ✨\n\nSe liberó un cupo para *${candidato.servicio_nombre}* el *${formatearFecha(fecha)}* a las *${formatearHora(hora)}*.\n\n¿Lo quieres? Responde *SÍ* en los próximos 15 minutos y te lo agendo. 🌸\n\n_Si no respondes, pasaremos al siguiente de la lista._`;

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
// MÁQUINA DE ESTADOS (CORREGIDA - motor lingüístico puro, sin dependencias externas)
// ═══════════════════════════════════════════════════════════════

async function detectarEstado(historial, cliente, textoUsuario, hoy, manana, pasado) {
  // MOTOR DE INTENCIONES PURAMENTE LINGÜÍSTICO
  // No depende de arrays externos - solo texto + contexto conversacional
  const t = textoUsuario.toLowerCase().trim();
  const ultimoAssistant = historial.filter(m => m.rol === 'assistant').pop()?.contenido?.toLowerCase() || '';
  const ultimoSystem = historial.filter(m => m.rol === 'system').pop()?.contenido || '';

  // Patrones de intención
  const intencionReagendar = /reagendar|mover|cambiar|modificar/.test(t);
  const intencionCancelar = /cancelar|anular|eliminar/.test(t);
  const intencionAgendar = /agendar|reservar|pedir|quiero|necesito|dame|pido/.test(t) && !intencionReagendar && !intencionCancelar;
  const intencionConfirmar = /^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va|bueno|sí|si$/.test(t);
  const intencionNegar = /^no|nope|paso|otro|diferente|cambiar/.test(t);

  // Cliente nuevo
  if (!cliente?.nombre) return { estado: 'inicio', intencion: 'registro' };

  // Respuesta a notificación de lista de espera
  if (ultimoSystem.includes('NOTIFICACION_LISTA_ESPERA')) {
    if (intencionConfirmar) return { estado: 'confirmar_lista_espera', intencion: 'agendar' };
    return { estado: 'rechazar_lista_espera', intencion: 'none' };
  }

  // Respuesta a recordatorio de confirmación
  if (ultimoAssistant.includes('¿todo en orden') || ultimoAssistant.includes('¿confirmas')) {
    if (intencionConfirmar) return { estado: 'confirmar_recordatorio', intencion: 'confirmar' };
    if (intencionNegar || intencionReagendar) return { estado: 'reagendar_listar', intencion: 'reagendar' };
  }

  // Respuesta a propuesta de cita
  if (ultimoAssistant.includes('¿te lo agendo') || ultimoAssistant.includes('¿confirmamos') || ultimoAssistant.includes('¿te parece')) {
    if (intencionConfirmar) return { estado: 'confirmar_cita', intencion: 'agendar' };
    if (intencionNegar) return { estado: 'esperando_fecha_hora', intencion: 'agendar' };
  }

  // Selección de especialista o "cualquiera"
  if (ultimoAssistant.includes('¿con quién') || ultimoAssistant.includes('te puedo ofrecer') || ultimoAssistant.includes('especialista')) {
    if (t.length < 25 || intencionConfirmar || /cualquiera|quien sea|el que tengas|la que tengas|me da igual|tú eliges/.test(t)) {
      return { estado: 'esperando_fecha_hora', intencion: 'agendar' };
    }
  }

  // Cuando pregunta día/hora
  if (ultimoAssistant.includes('¿qué día') || ultimoAssistant.includes('¿qué hora') || ultimoAssistant.includes('tengo disponible') || ultimoAssistant.includes('¿a qué hora')) {
    return { estado: 'procesar_fecha_hora', intencion: 'agendar' };
  }

  // Intenciones directas
  if (intencionReagendar) return { estado: 'reagendar_listar', intencion: 'reagendar' };
  if (intencionCancelar) return { estado: 'cancelar_listar', intencion: 'cancelar' };

  // Si el usuario menciona un servicio específico (detectado por palabras clave comunes)
  const palabrasServicio = /corte|cabello|pelo|tinte|color|manicure|pedicure|uñas|facial|masaje|depilación|cejas|pestañas|tratamiento|spa|botox|hidratación/.test(t);
  if (palabrasServicio && intencionAgendar) return { estado: 'esperando_especialista', intencion: 'agendar' };

  // Si menciona fecha u hora, probablemente está respondiendo sobre cuándo
  const mencionaFechaHora = /mañana|hoy|pasado|lunes|martes|miércoles|jueves|viernes|sábado|domingo|\d{1,2}:\d{2}|a las \d|am|pm/.test(t);
  if (mencionaFechaHora && (ultimoAssistant.includes('¿qué día') || ultimoAssistant.includes('¿a qué hora'))) {
    return { estado: 'procesar_fecha_hora', intencion: 'agendar' };
  }

  // Default: esperando servicio
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

    // ── Cargar datos ──
    let { data: cliente } = await supabase
      .from('clientes')
      .select('id, telefono, nombre, apellido, email, fecha_nacimiento, especialista_pref_id, local_pref_id, notas_bienestar')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: localesData } = await supabase.from('locales').select('id, nombre, direccion, hora_apertura, hora_cierre').eq('activo', true);
    const locales = Array.isArray(localesData) ? localesData : [];
    const { data: especialistasData } = await supabase.from('especialistas').select('id, nombre, rol, expertise, local_id, activo').eq('activo', true);
    const especialistas = Array.isArray(especialistasData) ? especialistasData : [];
    const { data: serviciosData } = await supabase.from('servicios').select('id, nombre, precio, duracion, categoria, descripcion_voda, local_id');
    const servicios = Array.isArray(serviciosData) ? serviciosData : [];

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
    let localId = null;
    let contexto = {};

    // ═══════════════════════════════════════════════════════
    // FLUJO: REGISTRO DE CLIENTE NUEVO
    // ═══════════════════════════════════════════════════════
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
            // Detectar si eligió local en el historial
            const localGuardado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('LOCAL_SELECCIONADO:')).pop()?.contenido?.replace('LOCAL_SELECCIONADO:', '');
            
            const { data: nuevoCliente, error: insertError } = await supabase
              .from('clientes')
              .insert({ 
                telefono: userPhone, 
                nombre, 
                apellido, 
                fecha_nacimiento: fechaNac,
                local_pref_id: localGuardado || null
              })
              .select().single();

            if (insertError && insertError.code === '23505') {
              const { data: updated } = await supabase.from('clientes')
                .update({ nombre, apellido, fecha_nacimiento: fechaNac, local_pref_id: localGuardado || null })
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
        // Primero preguntar local, luego datos personales
        if (locales?.length > 1 && !historial.some(m => m.rol === 'system' && m.contenido.startsWith('LOCAL_SELECCIONADO:'))) {
          const listaLocales = locales.map((l, i) => `${i + 1}. *${l.nombre}* — ${l.direccion}`).join('\n');
          respuesta = `¡Hola! 🌸 Soy Aura de AuraSync. ¿En qué local te gustaría agendar?\n\n${listaLocales}\n\nResponde con el número. ✨`;
        } else {
          respuesta = `¡Hola! 🌸 Soy Aura de AuraSync, encantada de conocerte. Para registrarte en nuestro sistema necesito: tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa). ¿Me los compartes?`;
        }
      }
    } else {
      // ═══════════════════════════════════════════════════════
      // FLUJO PRINCIPAL: MÁQUINA DE ESTADOS
      // ═══════════════════════════════════════════════════════
      
      // Detectar local activo
      const localGuardado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('LOCAL_SELECCIONADO:')).pop()?.contenido?.replace('LOCAL_SELECCIONADO:', '');
      localId = cliente?.local_pref_id || localGuardado || null;

      // Si no hay local seleccionado y hay múltiples locales, preguntar primero
      if (!localId && locales?.length > 1) {
        // Verificar si el mensaje actual es selección de local
        const seleccionLocal = parseInt(textoUsuario.trim());
        if (!isNaN(seleccionLocal) && seleccionLocal > 0 && seleccionLocal <= locales.length) {
          localId = locales[seleccionLocal - 1].id;
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `LOCAL_SELECCIONADO:${localId}` }
          ]);
          // Actualizar preferencia del cliente
          await supabase.from('clientes').update({ local_pref_id: localId }).eq('id', cliente.id);
          respuesta = `Perfecto, *${locales[seleccionLocal - 1].nombre}*. ¿Qué servicio te gustaría agendar hoy? 🌸`;
        } else {
          const listaLocales = locales.map((l, i) => `${i + 1}. *${l.nombre}* — ${l.direccion}`).join('\n');
          respuesta = `¡Hola ${cliente.nombre}! 🌸 ¿En qué local te atiendo hoy?\n\n${listaLocales}\n\nResponde con el número. ✨`;
        }
        
        // Guardar y salir
        await supabase.from('conversaciones').insert([
          { telefono: userPhone, rol: 'user', contenido: textoUsuario },
          { telefono: userPhone, rol: 'assistant', contenido: respuesta }
        ]);
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(`<Response><Message>${respuesta}</Message></Response>`);
      }

      // Si solo hay un local, usar ese por defecto
      if (!localId && locales?.length === 1) {
        localId = locales[0].id;
      }

      const estadoDetectado = await detectarEstado(historial, cliente, textoUsuario, hoy, manana, pasadoManana);
      console.log('🎯 Estado detectado:', estadoDetectado.estado, '| Intención:', estadoDetectado.intencion, '| Local:', localId);

      // Filtrar servicios y especialistas por local
      const serviciosLocal = servicios?.filter(s => !s.local_id || s.local_id === localId) || [];
      const especialistasLocal = especialistas?.filter(e => e.local_id === localId) || [];

      // ── CONFIRMAR DESDE LISTA DE ESPERA ──
      if (estadoDetectado.estado === 'confirmar_lista_espera') {
        const notifMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('NOTIFICACION_LISTA_ESPERA:')).pop()?.contenido;
        if (notifMatch) {
          const datosNotif = JSON.parse(notifMatch.replace('NOTIFICACION_LISTA_ESPERA:', ''));
          const disponible = await verificarDisponibilidad(datosNotif.fecha, datosNotif.hora, datosNotif.especialista, datosNotif.duracion, localId);
          if (!disponible.ok) {
            respuesta = "Lo siento, ese cupo ya fue tomado por otro cliente. Te mantengo en lista de espera por si se libera otro. 🌸";
          } else {
            const { data: citaSupabase, error: insertError } = await supabase
              .from('citas')
              .insert({
                cliente_id: cliente.id,
                servicio_id: datosNotif.servicio_id,
                especialista_id: datosNotif.especialista_id,
                local_id: localId,
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
                local: locales?.find(l => l.id === localId)?.nombre || '',
                precio: datosNotif.precio, duracion: datosNotif.duracion,
                supabase_id: citaSupabase.id, email: cliente.email || null,
                notas: cliente.notas_bienestar || null, observaciones: 'Agendada desde lista de espera'
              });

              await supabase.from('lista_espera').update({ estado: 'Confirmado', cita_resultante_id: citaSupabase.id }).eq('id', datosNotif.lista_espera_id);

              contexto = {
                accion: 'confirmar_lista_espera',
                servicio: datosNotif.servicio,
                fecha: formatearFecha(datosNotif.fecha),
                hora: formatearHora(datosNotif.hora),
                especialista: datosNotif.especialista,
                precio: datosNotif.precio,
                local: locales?.find(l => l.id === localId)?.nombre
              };
              respuesta = await generarRespuestaAura(contexto, historial);
              accionBackend = 'agendar';
            }
          }
        }
      }

      // ── RECHAZAR LISTA DE ESPERA ──
      else if (estadoDetectado.estado === 'rechazar_lista_espera') {
        contexto = { accion: 'rechazar_lista_espera' };
        respuesta = await generarRespuestaAura(contexto, historial);
      }

      // ── CONFIRMAR RECORDATORIO ──
      else if (estadoDetectado.estado === 'confirmar_recordatorio') {
        const citaIdMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('RECORDATORIO_CITA_ID:')).pop()?.contenido;
        if (citaIdMatch) {
          const citaId = citaIdMatch.replace('RECORDATORIO_CITA_ID:', '');
          await supabase.from('citas')
            .update({ confirmacion_cliente: 'Confirmada', cliente_confirmo_en: new Date().toISOString() })
            .eq('id', citaId);
          contexto = { accion: 'confirmar_recordatorio', nombre: cliente.nombre };
          respuesta = await generarRespuestaAura(contexto, historial);
        }
      }

      // ── REAGENDAR ──
      else if (estadoDetectado.intencion === 'reagendar' || estadoDetectado.estado === 'reagendar_listar') {
        const { data: citasConfirmadas } = await supabase
          .from('citas')
          .select('id, servicio_aux, duracion_aux, fecha_hora, especialista_id')
          .eq('cliente_id', cliente.id)
          .eq('local_id', localId)
          .eq('estado', 'Confirmada')
          .order('fecha_hora', { ascending: true })
          .limit(10);

        if (!citasConfirmadas?.length) {
          contexto = { accion: 'reagendar', citas: 0 };
          respuesta = await generarRespuestaAura(contexto, historial);
        } else {
          const espMap = {};
          especialistasLocal.forEach(e => espMap[e.id] = e.nombre);

          if (citasConfirmadas.length === 1) {
            const c = citasConfirmadas[0];
            const fecha = c.fecha_hora.split('T')[0];
            const hora = c.fecha_hora.substring(11, 16);
            contexto = {
              accion: 'reagendar',
              citas: 1,
              servicio: c.servicio_aux,
              fecha: formatearFecha(fecha),
              hora: formatearHora(hora),
              especialista: espMap[c.especialista_id] || 'Asignar'
            };
            respuesta = await generarRespuestaAura(contexto, historial);
            await supabase.from('conversaciones').insert([
              { telefono: userPhone, rol: 'system', contenido: `REAGENDAR_CITA_ID:${c.id}` }
            ]);
          } else {
            const listaCitas = citasConfirmadas.map((c, i) => {
              const f = c.fecha_hora.split('T')[0];
              const h = c.fecha_hora.substring(11, 16);
              return { index: i + 1, servicio: c.servicio_aux, fecha: formatearFecha(f), hora: formatearHora(h) };
            });
            contexto = { accion: 'reagendar', citas: citasConfirmadas.length, lista: listaCitas };
            respuesta = await generarRespuestaAura(contexto, historial);
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
          .eq('local_id', localId)
          .eq('estado', 'Confirmada')
          .order('fecha_hora', { ascending: true })
          .limit(10);

        if (!citasConfirmadas?.length) {
          contexto = { accion: 'cancelar', citas: 0 };
          respuesta = await generarRespuestaAura(contexto, historial);
        } else {
          const espMap = {};
          especialistasLocal.forEach(e => espMap[e.id] = e.nombre);
          if (citasConfirmadas.length === 1) {
            const c = citasConfirmadas[0];
            const f = c.fecha_hora.split('T')[0];
            const h = c.fecha_hora.substring(11, 16);
            contexto = {
              accion: 'cancelar',
              citas: 1,
              servicio: c.servicio_aux,
              fecha: formatearFecha(f),
              hora: formatearHora(h),
              especialista: espMap[c.especialista_id] || 'Asignar'
            };
            respuesta = await generarRespuestaAura(contexto, historial);
            await supabase.from('conversaciones').insert([
              { telefono: userPhone, rol: 'system', contenido: `CANCELAR_CITA_ID:${c.id}` }
            ]);
          } else {
            const listaCitas = citasConfirmadas.map((c, i) => {
              const f = c.fecha_hora.split('T')[0];
              const h = c.fecha_hora.substring(11, 16);
              return { index: i + 1, servicio: c.servicio_aux, fecha: formatearFecha(f), hora: formatearHora(h) };
            });
            contexto = { accion: 'cancelar', citas: citasConfirmadas.length, lista: listaCitas };
            respuesta = await generarRespuestaAura(contexto, historial);
          }
        }
        accionBackend = 'cancelar';
      }

      // ── CONFIRMAR CITA ──
      else if (estadoDetectado.estado === 'confirmar_cita') {
        const propuestaMatch = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('PROPUESTA_CITA:')).pop()?.contenido;

        if (!propuestaMatch) {
          contexto = { accion: 'error', mensaje: 'No recordé los detalles de la cita' };
          respuesta = await generarRespuestaAura(contexto, historial);
        } else {
          const datosPropuesta = JSON.parse(propuestaMatch.replace('PROPUESTA_CITA:', ''));

          const disponible = await verificarDisponibilidad(
            datosPropuesta.fecha, datosPropuesta.hora, datosPropuesta.especialista, datosPropuesta.duracion, localId
          );

          if (!disponible.ok) {
            const alternativa = await buscarAlternativa(
              datosPropuesta.fecha, datosPropuesta.hora, datosPropuesta.especialista, datosPropuesta.duracion, localId
            );
            contexto = {
              accion: 'conflicto_horario',
              mensaje: disponible.mensaje,
              alternativa: alternativa.mensaje,
              nuevaHora: alternativa.hora ? formatearHora(alternativa.hora) : null
            };
            respuesta = await generarRespuestaAura(contexto, historial);

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
                local_id: localId,
                fecha_hora: `${datosPropuesta.fecha}T${datosPropuesta.hora}:00-05:00`,
                estado: 'Confirmada',
                nombre_cliente_aux: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
                servicio_aux: datosPropuesta.servicio,
                duracion_aux: datosPropuesta.duracion
              })
              .select().single();

            if (insertError) {
              console.error('❌ Error insert Supabase:', insertError);
              contexto = { accion: 'error', mensaje: 'Problema guardando la cita' };
              respuesta = await generarRespuestaAura(contexto, historial);
            } else {
              const airtableRes = await crearCitaAirtable({
                telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido || '',
                fecha: datosPropuesta.fecha, hora: datosPropuesta.hora,
                servicio: datosPropuesta.servicio, especialista: datosPropuesta.especialista,
                local: locales?.find(l => l.id === localId)?.nombre || '',
                precio: datosPropuesta.precio, duracion: datosPropuesta.duracion,
                supabase_id: citaSupabase.id, email: cliente.email || null,
                notas: cliente.notas_bienestar || null, observaciones: 'Agendada por AuraSync'
              });

              contexto = {
                accion: 'confirmar_cita',
                servicio: datosPropuesta.servicio,
                fecha: formatearFecha(datosPropuesta.fecha),
                hora: formatearHora(datosPropuesta.hora),
                especialista: datosPropuesta.especialista,
                precio: datosPropuesta.precio,
                local: locales?.find(l => l.id === localId)?.nombre,
                airtableOk: airtableRes.ok
              };
              respuesta = await generarRespuestaAura(contexto, historial);
              accionBackend = 'agendar';
            }
          }
        }
      }

      // ── PROCESAR FECHA/HORA ──
      else if (estadoDetectado.estado === 'procesar_fecha_hora' || estadoDetectado.estado === 'esperando_fecha_hora') {
        let fecha = parsearFechaRelativa(textoUsuario, hoy, manana, pasadoManana);
        let hora = parsearHora(textoUsuario);

        if (!fecha) {
          const ultimaFechaMencionada = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('FECHA_PROPUESTA:')).pop()?.contenido;
          if (ultimaFechaMencionada) fecha = ultimaFechaMencionada.replace('FECHA_PROPUESTA:', '');
          else fecha = manana;
        }

        if (!hora) {
          contexto = {
            accion: 'pedir_hora',
            fecha: formatearFecha(fecha),
            horarioInicio: '9:00 a.m.',
            horarioFin: '6:00 p.m.'
          };
          respuesta = await generarRespuestaAura(contexto, historial);
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` }
          ]);
        } else {
          const servicioMencionado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('SERVICIO_SELECCIONADO:')).pop()?.contenido?.replace('SERVICIO_SELECCIONADO:', '');
          const servicioData = serviciosLocal?.find(s => s.nombre.toLowerCase() === (servicioMencionado || '').toLowerCase()) || serviciosLocal?.[0];

          let especialistaNombre = null;
          let especialistaId = null;

          for (const esp of especialistasLocal) {
            if (textoUsuario.toLowerCase().includes(esp.nombre.toLowerCase())) {
              especialistaNombre = esp.nombre;
              especialistaId = esp.id;
              break;
            }
          }

          if (!especialistaNombre) {
            const ultimaEsp = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('ESPECIALISTA_PROPUESTO:')).pop()?.contenido?.replace('ESPECIALISTA_PROPUESTO:', '');
            if (ultimaEsp) {
              const espData = especialistasLocal?.find(e => e.nombre === ultimaEsp);
              if (espData) { especialistaNombre = espData.nombre; especialistaId = espData.id; }
            }
          }

          if (!especialistaNombre) {
            const disponibles = await obtenerEspecialistasDisponibles(fecha, hora, servicioData?.duracion || 60, localId);
            if (disponibles.length === 0) {
              const alternativa = await buscarAlternativa(fecha, hora, null, servicioData?.duracion || 60, localId);
              contexto = {
                accion: 'sin_disponibilidad',
                servicio: servicioData?.nombre,
                fecha: formatearFecha(fecha),
                hora: formatearHora(hora),
                alternativa: alternativa.mensaje,
                ofrecerListaEspera: true
              };
              respuesta = await generarRespuestaAura(contexto, historial);

              if (alternativa.hora) {
                await supabase.from('conversaciones').insert([
                  { telefono: userPhone, rol: 'system', contenido: `LISTA_ESPERA_PROPUESTA:${JSON.stringify({
                    fecha, hora, servicio: servicioData?.nombre, servicio_id: servicioData?.id,
                    precio: servicioData?.precio, duracion: servicioData?.duracion, local_id: localId
                  })}` }
                ]);
              }
            } else {
              const topEspecialistas = disponibles.slice(0, 3);
              contexto = {
                accion: 'mostrar_especialistas',
                servicio: servicioData?.nombre,
                fecha: formatearFecha(fecha),
                hora: formatearHora(hora),
                especialistas: topEspecialistas.map(e => ({ nombre: e.nombre, expertise: e.expertise || e.rol }))
              };
              respuesta = await generarRespuestaAura(contexto, historial);

              await supabase.from('conversaciones').insert([
                { telefono: userPhone, rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData?.nombre}` },
                { telefono: userPhone, rol: 'system', contenido: `FECHA_PROPUESTA:${fecha}` },
                { telefono: userPhone, rol: 'system', contenido: `HORA_PROPUESTA:${hora}` }
              ]);
            }
          } else {
            const disponible = await verificarDisponibilidad(fecha, hora, especialistaNombre, servicioData?.duracion || 60, localId);

            if (!disponible.ok) {
              const alternativa = await buscarAlternativa(fecha, hora, especialistaNombre, servicioData?.duracion || 60, localId);
              contexto = {
                accion: 'conflicto_horario',
                especialista: especialistaNombre,
                mensaje: disponible.mensaje,
                alternativa: alternativa.mensaje
              };
              respuesta = await generarRespuestaAura(contexto, historial);
              
              if (alternativa.hora) {
                await supabase.from('conversaciones').insert([
                  { telefono: userPhone, rol: 'system', contenido: `PROPUESTA_CITA:${JSON.stringify({
                    fecha, hora: alternativa.hora, especialista: especialistaNombre,
                    especialista_id: especialistaId, servicio: servicioData?.nombre,
                    servicio_id: servicioData?.id, precio: servicioData?.precio,
                    duracion: servicioData?.duracion
                  })}` }
                ]);
              }
            } else {
              contexto = {
                accion: 'proponer_confirmacion',
                servicio: servicioData?.nombre,
                especialista: especialistaNombre,
                fecha: formatearFecha(fecha),
                hora: formatearHora(hora),
                precio: servicioData?.precio
              };
              respuesta = await generarRespuestaAura(contexto, historial);

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

      // ── MOSTRAR ESPECIALISTAS / SELECCIONAR SERVICIO ──
      else if (estadoDetectado.estado === 'esperando_especialista') {
        let servicioData = null;
        for (const s of serviciosLocal) {
          if (textoUsuario.toLowerCase().includes(s.nombre.toLowerCase()) || 
              textoUsuario.toLowerCase().includes(s.categoria?.toLowerCase() || '')) {
            servicioData = s;
            break;
          }
        }

        if (!servicioData) {
          const servicioGuardado = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('SERVICIO_SELECCIONADO:')).pop()?.contenido?.replace('SERVICIO_SELECCIONADO:', '');
          servicioData = serviciosLocal?.find(s => s.nombre === servicioGuardado);
        }

        if (!servicioData) {
          contexto = {
            accion: 'mostrar_servicios',
            servicios: serviciosLocal.map(s => ({ nombre: s.nombre, precio: s.precio, duracion: s.duracion }))
          };
          respuesta = await generarRespuestaAura(contexto, historial);
        } else {
          await supabase.from('conversaciones').insert([
            { telefono: userPhone, rol: 'system', contenido: `SERVICIO_SELECCIONADO:${servicioData.nombre}` }
          ]);
          contexto = {
            accion: 'servicio_seleccionado',
            servicio: servicioData.nombre,
            precio: servicioData.precio,
            duracion: servicioData.duracion
          };
          respuesta = await generarRespuestaAura(contexto, historial);
        }
      }

      // ── LISTA DE ESPERA: USUARIO DICE "SÍ" ──
      else if (historial.some(m => m.rol === 'system' && m.contenido.startsWith('LISTA_ESPERA_PROPUESTA:'))) {
        const propuestaLE = historial.filter(m => m.rol === 'system' && m.contenido.startsWith('LISTA_ESPERA_PROPUESTA:')).pop()?.contenido;
        if (propuestaLE && /^s[ií]|dale|ok|perfecto|súper|agéndalo|confirmo|va|bueno/.test(textoUsuario.toLowerCase())) {
          const datosLE = JSON.parse(propuestaLE.replace('LISTA_ESPERA_PROPUESTA:', ''));
          const resultado = await agregarAListaEspera({
            cliente_id: cliente.id,
            telefono: userPhone,
            nombre: `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
            local_id: localId,
            fecha: datosLE.fecha,
            hora: datosLE.hora,
            servicio_id: datosLE.servicio_id,
            servicio: datosLE.servicio,
            especialista_id: null,
            especialista: null
          });
          if (resultado.ok) {
            contexto = {
              accion: 'lista_espera_confirmada',
              servicio: datosLE.servicio,
              fecha: formatearFecha(datosLE.fecha),
              hora: formatearHora(datosLE.hora)
            };
          } else {
            contexto = { accion: 'error', mensaje: 'Problema agregando a lista de espera' };
          }
          respuesta = await generarRespuestaAura(contexto, historial);
        } else {
          contexto = { accion: 'lista_espera_rechazada' };
          respuesta = await generarRespuestaAura(contexto, historial);
        }
      }

      // ── ESTADO INICIAL / ESPERANDO SERVICIO ──
      else {
        contexto = {
          accion: 'saludo',
          nombre: cliente.nombre,
          serviciosPopulares: serviciosLocal.slice(0, 3).map(s => ({ nombre: s.nombre, precio: s.precio }))
        };
        respuesta = await generarRespuestaAura(contexto, historial);
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
