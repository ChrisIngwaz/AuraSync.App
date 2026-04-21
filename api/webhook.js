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
// FUNCIONES DE FECHA/HORA
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

// ═══════════════════════════════════════════════════════════════
// AIRTABLE: BÚSQUEDA ROBUSTA POR MÚLTIPLES CRITERIOS
// ═══════════════════════════════════════════════════════════════

async function buscarCitaAirtable({ supabaseId, telefono, fecha, hora, especialista }) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;

    if (supabaseId) {
      const filter1 = encodeURIComponent(`{ID_Supabase} = '${supabaseId}'`);
      const res1 = await axios.get(`${url}?filterByFormula=${filter1}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res1.data.records?.length) {
        console.log('✅ Airtable encontrado por ID_Supabase:', supabaseId);
        return { ok: true, record: res1.data.records[0] };
      }
      console.log('⚠️ No encontrado por ID_Supabase:', supabaseId, '- intentando fallback...');
    }

    if (telefono && fecha && hora) {
      const condiciones = [
        `{Teléfono} = '${telefono}'`,
        `IS_SAME({Fecha}, '${fecha}', 'days')`,
        `{Hora} = '${hora}'`
      ];
      if (especialista) condiciones.push(`{Especialista} = '${especialista}'`);

      const filter2 = encodeURIComponent(`AND(${condiciones.join(', ')})`);
      const res2 = await axios.get(`${url}?filterByFormula=${filter2}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res2.data.records?.length) {
        console.log('✅ Airtable encontrado por fallback teléfono+fecha+hora');
        return { ok: true, record: res2.data.records[0] };
      }
    }

    if (telefono && fecha) {
      const filter3 = encodeURIComponent(`AND({Teléfono} = '${telefono}', IS_SAME({Fecha}, '${fecha}', 'days'))`);
      const res3 = await axios.get(`${url}?filterByFormula=${filter3}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res3.data.records?.length) {
        console.log('✅ Airtable encontrado por fallback teléfono+fecha');
        return { ok: true, record: res3.data.records[0] };
      }
    }

    console.log('❌ Cita no encontrada en Airtable con ningún criterio');
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

    console.log('📝 Creando en Airtable - ID_Supabase:', datos.supabase_id);

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

    console.log('✅ Airtable creado, record ID:', response.data.records?.[0]?.id);
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
      supabaseId,
      telefono: nuevosDatos.telefono,
      fecha: nuevosDatos.fechaAnterior,
      hora: nuevosDatos.horaAnterior,
      especialista: nuevosDatos.especialistaAnterior
    });

    if (!busqueda.ok) {
      console.error('❌ No se pudo encontrar la cita en Airtable para actualizar');
      return { ok: false, error: 'Cita no encontrada en Airtable' };
    }

    const recordId = busqueda.record.id;
    const [h, min] = nuevosDatos.hora.split(':').map(Number);
    const [anio, mes, dia] = nuevosDatos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    const payload = {
      records: [{
        id: recordId,
        fields: {
          "Fecha": fechaUTC,
          "Hora": nuevosDatos.hora,
          "Especialista": nuevosDatos.especialista,
          "Estado": "Confirmada",
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

    console.log('✅ Airtable actualizado, record ID:', recordId);
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
      supabaseId,
      telefono: datosFallback?.telefono,
      fecha: datosFallback?.fecha,
      hora: datosFallback?.hora,
      especialista: datosFallback?.especialista
    });

    if (!busqueda.ok) {
      console.error('❌ No se pudo encontrar la cita en Airtable para cancelar');
      return { ok: false, error: 'Cita no encontrada en Airtable' };
    }

    const recordId = busqueda.record.id;

    await axios.patch(url, {
      records: [{
        id: recordId,
        fields: {
          "Estado": "Cancelada",
          "Observaciones de confirmación": motivo ? `Cancelada: ${motivo}` : "Cancelada por cliente"
        }
      }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    console.log('✅ Airtable cancelado, record ID:', recordId);
    return { ok: true, recordId };
  } catch (error) {
    console.error('Error Airtable Cancel:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// VERIFICACIÓN DE DISPONIBILIDAD (Airtable + Supabase)
// ═══════════════════════════════════════════════════════════════

async function obtenerCitasDelDia(fecha) {
  try {
    const inicioDia = `${fecha}T00:00:00`;
    const finDia = `${fecha}T23:59:59`;

    const { data: citasSupabase, error: supaError } = await supabase
      .from('citas')
      .select('id, fecha_hora, especialista_id, duracion_aux, servicio_aux, estado, nombre_cliente_aux')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);

    if (supaError) {
      console.error('Error Supabase citas:', supaError);
      return [];
    }

    const { data: especialistasData } = await supabase
      .from('especialistas')
      .select('id, nombre');

    const mapaEspecialistas = {};
    (especialistasData || []).forEach(e => { mapaEspecialistas[e.id] = e.nombre; });

    const citas = (citasSupabase || []).map(c => {
      const hora = c.fecha_hora ? c.fecha_hora.substring(11, 16) : null;
      const nombreEsp = mapaEspecialistas[c.especialista_id] || 'Asignar';
      return {
        hora,
        duracion: c.duracion_aux || 60,
        especialista: nombreEsp,
        servicio: c.servicio_aux,
        idSupabase: c.id
      };
    }).filter(c => c.hora);

    console.log(`📅 Citas encontradas para ${fecha}:`, citas.length);
    citas.forEach(c => console.log(`   ${c.hora} - ${c.especialista} - ${c.servicio}`));

    return citas;
  } catch (error) {
    console.error('Error obteniendo citas del día:', error.message);
    return [];
  }
}

async function verificarDisponibilidad(fecha, hora, especialistaSolicitado, duracionMinutos) {
  const citas = await obtenerCitasDelDia(fecha);

  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracionMinutos || 60);

  if (inicioNuevo < 540) {
    return { ok: false, mensaje: "Nuestro horario comienza a las 9:00 a.m. 🌅" };
  }
  if (finNuevo > 1080) {
    return { ok: false, mensaje: "Ese horario excede nuestra jornada (hasta las 6:00 p.m.). ¿Te funciona más temprano?" };
  }

  for (const cita of citas) {
    if (!cita.hora) continue;
    const [he, me] = cita.hora.split(':').map(Number);
    const inicioExistente = he * 60 + me;
    const finExistente = inicioExistente + (cita.duracion || 60);

    if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
      if (!especialistaSolicitado || cita.especialista === especialistaSolicitado) {
        return {
          ok: false,
          mensaje: `Ups, ${cita.especialista || 'ese horario'} ya está ocupado${cita.servicio ? ` con un ${cita.servicio}` : ''}. 😔`,
          conflictoCon: cita
        };
      }
    }
  }

  return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
}

async function buscarAlternativa(fecha, horaSolicitada, especialistaSolicitado, duracion) {
  const citas = await obtenerCitasDelDia(fecha);
  const [h, m] = horaSolicitada.split(':').map(Number);

  let horaPropuesta = h * 60 + m;

  while (horaPropuesta <= 1080 - duracion) {
    let conflicto = false;

    for (const cita of citas) {
      if (!cita.hora) continue;
      const [ho, mo] = cita.hora.split(':').map(Number);
      const inicioOcupado = ho * 60 + mo;
      const finOcupado = inicioOcupado + (cita.duracion || 60);

      if (horaPropuesta < finOcupado && (horaPropuesta + duracion) > inicioOcupado) {
        if (!especialistaSolicitado || cita.especialista === especialistaSolicitado) {
          conflicto = true;
          break;
        }
      }
    }

    if (!conflicto) {
      const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
      return { mensaje: `¿Qué tal a las ${formatearHora(horaStr)}?`, hora: horaStr };
    }

    horaPropuesta += 15;
  }

  return { mensaje: "Ese día ya no tenemos cupos disponibles. ¿Te parece otro día? 📅" };
}

// ═══════════════════════════════════════════════════════════════
// VALIDACIÓN DE FECHA DE NACIMIENTO
// ═══════════════════════════════════════════════════════════════

function validarFechaNacimiento(fechaStr) {
  if (!fechaStr) return null;
  
  const partes = fechaStr.split(/[\/-]/);
  if (partes.length !== 3) return null;
  
  const dia = parseInt(partes[0], 10);
  const mes = parseInt(partes[1], 10);
  const anio = parseInt(partes[2], 10);
  
  if (isNaN(dia) || isNaN(mes) || isNaN(anio)) return null;
  if (mes < 1 || mes > 12) return null;
  if (dia < 1 || dia > 31) return null;
  if (anio < 1900 || anio > new Date().getFullYear()) return null;
  
  const diasPorMes = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if ((anio % 4 === 0 && anio % 100 !== 0) || (anio % 400 === 0)) {
    diasPorMes[1] = 29;
  }
  if (dia > diasPorMes[mes - 1]) return null;
  
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
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
          {
            headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        console.error('Error Deepgram:', error.message);
      }
    }

    // ── Cargar datos reales de Supabase ──
    let { data: cliente } = await supabase
      .from('clientes')
      .select('id, telefono, nombre, apellido, email, fecha_nacimiento, especialista_pref_id, notas_bienestar')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: especialistas } = await supabase
      .from('especialistas')
      .select('id, nombre, rol, expertise, local_id');

    const { data: servicios } = await supabase
      .from('servicios')
      .select('id, nombre, precio, duracion, categoria, descripcion_voda');

    const esNuevo = !cliente || !cliente.nombre || cliente.nombre.trim() === '';

    let historialFiltrado = [];
    const { data: mensajes } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(12);
    
    if (mensajes) historialFiltrado = mensajes.reverse();

    const yaSePidieronDatos = esNuevo && historialFiltrado.some(
      m => m.rol === 'assistant' && 
          (m.contenido.toLowerCase().includes('nombre') || 
           m.contenido.toLowerCase().includes('registr'))
    );

    const catalogoEspecialistas = (especialistas || [])
      .map(e => `- ${e.nombre}${e.expertise ? ` (${e.expertise})` : ''}${e.rol ? ` — ${e.rol}` : ''}`)
      .join('\n');

    const catalogoServicios = (servicios || [])
      .map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion} min${s.categoria ? ` [${s.categoria}]` : ''}${s.descripcion_voda ? ` — ${s.descripcion_voda}` : ''}`)
      .join('\n');

    const hoy = getFechaEcuador(0);
    const manana = getFechaEcuador(1);
    const pasadoManana = getFechaEcuador(2);

    // ── SYSTEM PROMPT ──
    const systemPrompt = `Eres Aura, asistente de AuraSync. Eres una coordinadora humana, cálida, elegante y eficiente. NUNCA eres robótica.

═══════════════════════════════════════════════════════════════
DATOS REALES DEL NEGOCIO — USAR EXACTAMENTE ESTOS, NUNCA INVENTAR:
═══════════════════════════════════════════════════════════════

ESPECIALISTAS DISPONIBLES (solo estos existen):
${catalogoEspecialistas || "(Consultar con recepción)"}

SERVICIOS DISPONIBLES (solo estos existen):
${catalogoServicios || "(Consultar con recepción)"}

═══════════════════════════════════════════════════════════════
ESTADO DEL CLIENTE:
═══════════════════════════════════════════════════════════════
${esNuevo ? `⚠️ CLIENTE NUEVO — Este número NO está registrado en el sistema.
FLUJO OBLIGATORIO — SIN EXCEPCIONES:
1. Saluda cálidamente, preséntate como Aura de AuraSync.
2. En ESE MISMO primer mensaje pide los 3 datos JUNTOS:
   • Nombre y apellido
   • Fecha de nacimiento (formato: dd/mm/aaaa)
   EJEMPLO EXACTO: "¡Hola! 🌸 Soy Aura de AuraSync, encantada de conocerte. Para registrarte en nuestro sistema necesito: tu *nombre y apellido* y tu *fecha de nacimiento* (dd/mm/aaaa). ¿Me los compartes?"
3. Cuando el cliente responda con sus datos, extráelos en el JSON con accion "registrar".
4. Después confirma el registro y pregunta en qué puedes ayudarle.
CRÍTICO: NUNCA pidas un dato por mensaje. SIEMPRE los 3 datos en UN SOLO mensaje.
CRÍTICO: NUNCA uses datos de conversaciones anteriores. Este cliente es completamente nuevo.
${yaSePidieronDatos ? '\nNOTA: Ya se pidieron los datos anteriormente. Si el usuario responde ahora, extrae los datos de su mensaje y usa accion "registrar".' : ''}`
: `✅ CLIENTE REGISTRADO — Nombre: ${cliente.nombre} ${cliente.apellido || ''}. No pidas datos que ya tenemos.`}

═══════════════════════════════════════════════════════════════
REGLAS DE ORO — VIOLARLAS ES UN ERROR CRÍTICO:
═══════════════════════════════════════════════════════════════

1. NUNCA inventes especialistas. Si el cliente pide uno que NO está en la lista, di: "Ese especialista no está disponible, pero te puedo ofrecer a [nombre real de la lista]."

2. NUNCA inventes servicios, precios ni duraciones. Usa EXACTAMENTE los datos de arriba.

3. FLUJO CONVERSACIONAL (una pregunta por mensaje, NUNCA repetitivo):

   Paso 1: Saludo cálido + ¿qué servicio necesita? (SOLO si el cliente NO lo dijo ya)

   Paso 2: Presentar MÍNIMO 2 especialistas con su expertise:
           "Para [servicio] te puedo ofrecer a:
            • [Especialista 1] — [expertise del especialista 1]
            • [Especialista 2] — [expertise del especialista 2]
            ¿Con quién te gustaría agendar?"

   Paso 3: Cuando elija especialista, proponer fecha/hora:
           • Si el cliente YA dijo hora: "Perfecto, te confirmo [especialista] a las [hora] que pediste. ¿Te lo agendo?"
           • Si NO dijo hora: "¿Qué día y hora te funciona? Tengo disponible mañana a las 10:00 o 15:00."

   Paso 4: Esperar confirmación explícita ("sí", "dale", "ok", "agéndalo")

   Paso 5: SOLO entonces ejecutar la acción

4. REGLAS ANTI-REDUNDANCIA (NUNCA violar):
   • Si el cliente dijo "quiero a las 17", NUNCA digas "¿te parece a las 17?". Dilo como hecho: "Te confirmo a las 5:00 p.m."
   • Si el cliente eligió un especialista, NUNCA vuelvas a preguntar "¿con Carlos?"
   • Si el cliente confirmó todo, NUNCA repitas los detalles de nuevo antes de ejecutar.
   • NUNCA saludes, sugieras especialista Y propongas horario en el mismo mensaje.
   • Máximo 3 mensajes de intercambio antes de la confirmación final.

5. Para REAGENDAR — REGLAS ESTRICTAS:
   • Cuando el cliente diga "quiero cambiar/mover/reagendar mi cita", PRIMERO dile EXACTAMENTE qué citas tiene:
     "Veo que tienes [N] citas confirmadas:
      1. [SERVICIO] el [FECHA] a las [HORA] con [ESPECIALISTA]
      2. [SERVICIO] el [FECHA] a las [HORA] con [ESPECIALISTA]
      ¿Cuál quieres mover?"
   • Cuando el cliente confirme CUÁL cita (diciendo el número, la fecha, la hora o el servicio), propón nueva fecha/hora.
   • Si el cliente dice "mi cita de mañana a las 11", DEBES incluir en el JSON:
     "cita_fecha_original": "2026-04-22" (la fecha real en formato YYYY-MM-DD)
     "cita_hora_original": "11:00" (la hora en formato HH:MM)
   • Si el cliente dice "mi cita de hoy", usa la fecha de hoy.
   • Si el cliente dice "mi cita de [día de la semana]", calcula la fecha correcta.
   • NUNCA inventes la fecha/hora original. Si no estás seguro, pregunta.
   • NUNCA cambies el servicio de la cita al reagendar. El servicio debe permanecer igual.
   • En el JSON, DEBES incluir "cita_fecha_original" y "cita_hora_original" con los valores EXACTOS de la cita que el cliente confirmó mover.

6. Para CANCELAR: confirma cuál cita quiere cancelar, luego ejecuta.

7. Mantén mensajes cortos, como WhatsApp real. Máximo 2-3 oraciones por mensaje.

8. Usa emojis con moderación y elegancia. 🌸 ✨ 💫

9. Si no entiendes algo, pregunta amablemente. Nunca asumas.

10. Si el cliente menciona un servicio parecido pero no exacto, sugiere el más cercano de la lista real.

═══════════════════════════════════════════════════════════════
FECHAS DE REFERENCIA:
═══════════════════════════════════════════════════════════════
- Hoy: ${formatearFecha(hoy)} (${hoy})
- Mañana: ${formatearFecha(manana)} (${manana})
- Pasado mañana: ${formatearFecha(pasadoManana)} (${pasadoManana})

═══════════════════════════════════════════════════════════════
FORMATO DATA_JSON (obligatorio al final de CADA respuesta):
═══════════════════════════════════════════════════════════════
DATA_JSON:{
  "accion": "none" | "registrar" | "agendar" | "cancelar" | "reagendar",
  "nombre": "",
  "apellido": "",
  "fecha_nacimiento": "DD/MM/AAAA",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "nombre exacto del servicio",
  "cita_especialista": "nombre exacto del especialista o vacío",
  "cita_fecha_original": "YYYY-MM-DD",
  "cita_hora_original": "HH:MM"
}

REGLAS DEL JSON:
- "accion": "registrar" cuando el cliente proporcione nombre, apellido y fecha de nacimiento.
- "accion": "agendar" SOLO cuando el cliente CONFIRME explícitamente el horario propuesto.
- "accion": "reagendar" SOLO cuando el cliente CONFIRME explícitamente la nueva fecha/hora.
- "accion": "cancelar" SOLO cuando el cliente CONFIRME explícitamente que quiere cancelar.
- "cita_servicio": debe coincidir EXACTAMENTE con un nombre de la lista de servicios.
- "cita_especialista": debe coincidir EXACTAMENTE con un nombre de la lista de especialistas, o vacío si no importa.
- "cita_fecha_original" y "cita_hora_original": OBLIGATORIOS para reagendar.`;

    // ── Construir mensajes para OpenAI ──
    const messages = [{ role: "system", content: systemPrompt }];

    historialFiltrado.forEach(msg => {
      messages.push({
        role: msg.rol === 'assistant' ? 'assistant' : 'user',
        content: msg.contenido
      });
    });

    messages.push({ role: "user", content: textoUsuario });

    // ── Llamada a OpenAI ──
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.2,
      max_tokens: 400
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let fullReply = aiRes.data.choices[0].message.content;
    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';

    // ── Extraer JSON ──
    const jsonMatch = fullReply.match(/(?:DATA_JSON\s*:?\s*)?(?:\`\`\`json\s*)?(\{[\s\S]*?"accion"[\s\S]*?\})(?:\s*\`\`\`)?/i);

    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        const textoLower = (textoUsuario || '').toLowerCase();

        let fechaFinal = manana;
        if (textoLower.includes('hoy')) fechaFinal = hoy;
        else if (datosExtraidos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/)) fechaFinal = datosExtraidos.cita_fecha;

        const accion = datosExtraidos.accion || 'none';

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: REGISTRAR CLIENTE NUEVO
        // ═══════════════════════════════════════════════════════
        if (accion === 'registrar' && esNuevo) {
          const nombreJSON = (datosExtraidos.nombre || '').trim();
          const apellidoJSON = (datosExtraidos.apellido || '').trim();
          const fechaNacJSON = (datosExtraidos.fecha_nacimiento || '').trim();

          if (!nombreJSON || !apellidoJSON) {
            console.log('⚠️ Datos incompletos para registro. Nombre o apellido faltante.');
            mensajeAccion = "Necesito que me compartas tu *nombre y apellido* completos, por favor. 🌸";
            accionEjecutada = true;
          } else {
            const fechaNacISO = validarFechaNacimiento(fechaNacJSON);
            
            if (!fechaNacISO) {
              console.log('⚠️ Fecha de nacimiento inválida:', fechaNacJSON);
              mensajeAccion = "La fecha de nacimiento no parece correcta. ¿Me la compartes en formato *dd/mm/aaaa*? Por ejemplo: 15/03/1990 🌸";
              accionEjecutada = true;
            } else {
              const { data: nuevoCliente, error: insertError } = await supabase
                .from('clientes')
                .insert({
                  telefono: userPhone,
                  nombre: nombreJSON,
                  apellido: apellidoJSON,
                  fecha_nacimiento: fechaNacISO
                })
                .select()
                .single();

              if (insertError) {
                console.error('❌ Error registrando cliente:', insertError);
                if (insertError.code === '23505') {
                  const { data: updatedCliente, error: updateError } = await supabase
                    .from('clientes')
                    .update({
                      nombre: nombreJSON,
                      apellido: apellidoJSON,
                      fecha_nacimiento: fechaNacISO
                    })
                    .eq('telefono', userPhone)
                    .select()
                    .single();
                    
                  if (updateError) {
                    mensajeAccion = "Tuve un problema registrando tus datos. ¿Lo intentamos de nuevo? 🙏";
                  } else {
                    cliente = updatedCliente;
                    console.log('✅ Cliente actualizado (teléfono existente):', nombreJSON, apellidoJSON);
                    mensajeAccion = `¡Listo, ${nombreJSON}! 🌸 Ya estás registrado/a en AuraSync. ¿En qué puedo ayudarte hoy?`;
                  }
                } else {
                  mensajeAccion = "Tuve un problema registrando tus datos. ¿Lo intentamos de nuevo? 🙏";
                }
              } else {
                cliente = nuevoCliente;
                console.log('✅ Cliente registrado:', nombreJSON, apellidoJSON);
                mensajeAccion = `¡Listo, ${nombreJSON}! 🌸 Ya estás registrado/a en AuraSync. ¿En qué puedo ayudarte hoy?`;
              }
              accionEjecutada = true;
            }
          }
        }

        const servicioData = servicios?.find(s =>
          s.nombre.toLowerCase().includes((datosExtraidos.cita_servicio || '').toLowerCase())
        ) || { id: null, nombre: datosExtraidos.cita_servicio || "Servicio", precio: 0, duracion: 60 };

        const especialistaData = especialistas?.find(e =>
          e.nombre.toLowerCase().includes((datosExtraidos.cita_especialista || '').toLowerCase())
        ) || null;

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: AGENDAR
        // ═══════════════════════════════════════════════════════
        if (accion === 'agendar') {
          if (esNuevo && !cliente?.id) {
            mensajeAccion = "Primero necesito registrarte. ¿Me compartes tu *nombre, apellido* y *fecha de nacimiento* (dd/mm/aaaa)? 🌸";
            accionEjecutada = true;
          } else {
            const tieneHora = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);

            if (fechaFinal && tieneHora) {
              const disponible = await verificarDisponibilidad(
                fechaFinal,
                datosExtraidos.cita_hora,
                datosExtraidos.cita_especialista,
                servicioData.duracion
              );

              if (!disponible.ok) {
                const alternativa = await buscarAlternativa(
                  fechaFinal,
                  datosExtraidos.cita_hora,
                  datosExtraidos.cita_especialista,
                  servicioData.duracion
                );
                mensajeAccion = `${disponible.mensaje} ${alternativa.mensaje}`;
              } else {
                const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
                const especialistaIdFinal = especialistaData?.id || null;

                const { data: citaSupabase, error: insertError } = await supabase
                  .from('citas')
                  .insert({
                    cliente_id: cliente?.id || null,
                    servicio_id: servicioData.id || null,
                    especialista_id: especialistaIdFinal,
                    fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                    estado: 'Confirmada',
                    nombre_cliente_aux: `${datosExtraidos.nombre || cliente?.nombre || ''} ${datosExtraidos.apellido || cliente?.apellido || ''}`.trim(),
                    servicio_aux: servicioData.nombre,
                    duracion_aux: servicioData.duracion
                  })
                  .select()
                  .single();

                if (insertError) {
                  console.error('❌ Error insert Supabase:', insertError);
                  mensajeAccion = "Ups, tuve un problema guardando tu cita. ¿Me das un momento? 🙏";
                } else {
                  console.log('✅ Supabase creado, ID:', citaSupabase?.id);

                  const airtableRes = await crearCitaAirtable({
                    telefono: userPhone,
                    nombre: datosExtraidos.nombre || cliente?.nombre || '',
                    apellido: datosExtraidos.apellido || cliente?.apellido || '',
                    fecha: fechaFinal,
                    hora: datosExtraidos.cita_hora,
                    servicio: servicioData.nombre,
                    especialista: especialistaFinal,
                    precio: servicioData.precio,
                    duracion: servicioData.duracion,
                    supabase_id: citaSupabase?.id || null,
                    email: cliente?.email || null,
                    notas: cliente?.notas_bienestar || null,
                    observaciones: `Agendada por AuraSync`
                  });

                  if (airtableRes.ok) {
                    mensajeAccion = `✨ ¡Listo! Tu cita para ${servicioData.nombre} está confirmada:\n📅 ${formatearFecha(fechaFinal)}\n⏰ ${formatearHora(datosExtraidos.cita_hora)}\n💇‍♀️ Con ${especialistaFinal}\n💰 $${servicioData.precio}\n\nTe esperamos con mucho cariño. 🌸`;
                  } else {
                    mensajeAccion = `✅ Tu cita está guardada en nuestro sistema principal. Te confirmo los detalles:\n📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(datosExtraidos.cita_hora)}\n💇‍♀️ ${servicioData.nombre} con ${especialistaFinal}`;
                  }
                }
              }
              accionEjecutada = true;
            }
          }
        }

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: REAGENDAR — CORREGIDO
        // ═══════════════════════════════════════════════════════
        else if (accion === 'reagendar') {
          const tieneHoraNueva = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);
          const tieneFechaNueva = datosExtraidos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/);

          if (!tieneFechaNueva || !tieneHoraNueva) {
            console.log('⚠️ Reagendar: falta fecha u hora nueva');
            mensajeAccion = "¿Me confirmas la nueva fecha y hora a la que quieres mover tu cita? 📅";
            accionEjecutada = true;
          } else {
            fechaFinal = datosExtraidos.cita_fecha;

            const { data: clienteActual } = await supabase
              .from('clientes')
              .select('id, nombre, apellido, email')
              .eq('telefono', userPhone)
              .maybeSingle();

            const clienteId = clienteActual?.id || cliente?.id;
            const clienteNombre = clienteActual?.nombre || cliente?.nombre || datosExtraidos.nombre || '';
            const clienteApellido = clienteActual?.apellido || cliente?.apellido || datosExtraidos.apellido || '';

            let todasLasCitas = [];
            let busquedaPor = '';

            if (clienteId) {
              const { data: citasPorId } = await supabase
                .from('citas')
                .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id, estado, nombre_cliente_aux')
                .eq('cliente_id', clienteId)
                .eq('estado', 'Confirmada')
                .order('fecha_hora', { ascending: true })
                .limit(10);

              if (citasPorId?.length) {
                todasLasCitas = citasPorId;
                busquedaPor = 'cliente_id';
              }
            }

            if (!todasLasCitas.length && (clienteNombre || clienteApellido)) {
              const nombreBusqueda = `${clienteNombre} ${clienteApellido}`.trim();
              const { data: citasPorNombre } = await supabase
                .from('citas')
                .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id, estado, nombre_cliente_aux')
                .ilike('nombre_cliente_aux', `%${nombreBusqueda}%`)
                .eq('estado', 'Confirmada')
                .order('fecha_hora', { ascending: true })
                .limit(10);

              if (citasPorNombre?.length) {
                todasLasCitas = citasPorNombre;
                busquedaPor = 'nombre';
              }
            }

            if (!todasLasCitas.length) {
              mensajeAccion = "No encontré citas confirmadas a tu nombre para reagendar. ¿Quieres que agende una nueva? 💫";
              accionEjecutada = true;
            } else {
              const { data: espData } = await supabase.from('especialistas').select('id, nombre');
              const mapaEsp = {};
              (espData || []).forEach(e => { mapaEsp[e.id] = e.nombre; });

              todasLasCitas = todasLasCitas.map(c => ({
                ...c,
                especialista_nombre: mapaEsp[c.especialista_id] || 'Asignar'
              }));

              console.log('📋 Citas encontradas:', todasLasCitas.map(c => 
                `${c.servicio_aux} el ${c.fecha_hora?.split('T')[0]} a las ${c.fecha_hora?.substring(11, 16)} con ${c.especialista_nombre}`
              ));

              let citaAMover = null;
              const textoLower2 = (textoUsuario || '').toLowerCase();

              // Estrategia A: Por fecha_original + hora_original del JSON
              if (datosExtraidos.cita_fecha_original && datosExtraidos.cita_hora_original) {
                const fechaOriginalStr = datosExtraidos.cita_fecha_original;
                const horaOriginalStr = datosExtraidos.cita_hora_original;
                
                citaAMover = todasLasCitas.find(c => {
                  if (!c.fecha_hora) return false;
                  const fechaCita = c.fecha_hora.split('T')[0];
                  const horaCita = c.fecha_hora.substring(11, 16);
                  return fechaCita === fechaOriginalStr && horaCita === horaOriginalStr;
                });
                
                if (citaAMover) console.log('✅ Cita encontrada por fecha+hora exacta del JSON:', citaAMover.fecha_hora);
              }

              // Estrategia B: Por servicio mencionado en el JSON
              if (!citaAMover && datosExtraidos.cita_servicio) {
                const servicioBuscado = datosExtraidos.cita_servicio.toLowerCase();
                citaAMover = todasLasCitas.find(c => 
                  c.servicio_aux?.toLowerCase().includes(servicioBuscado)
                );
                if (citaAMover) console.log('✅ Cita encontrada por servicio:', citaAMover.servicio_aux);
              }

              // Estrategia C: Extraer fecha y hora del texto del usuario
              if (!citaAMover) {
                let fechaMencionada = null;
                let horaMencionada = null;

                if (textoLower2.includes('hoy')) fechaMencionada = getFechaEcuador(0);
                else if (textoLower2.includes('mañana')) fechaMencionada = getFechaEcuador(1);
                else if (textoLower2.includes('pasado mañana')) fechaMencionada = getFechaEcuador(2);
                
                const horaMatch = textoUsuario.match(/(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:am|pm|a\.m\.|p\.m\.)?/i);
                if (horaMatch) {
                  let h = parseInt(horaMatch[1], 10);
                  const m = horaMatch[2] ? parseInt(horaMatch[2], 10) : 0;
                  if (textoLower2.includes('pm') || textoLower2.includes('p.m.')) {
                    if (h < 12) h += 12;
                  }
                  horaMencionada = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                }

                if (fechaMencionada && horaMencionada) {
                  citaAMover = todasLasCitas.find(c => {
                    if (!c.fecha_hora) return false;
                    const fechaCita = c.fecha_hora.split('T')[0];
                    const horaCita = c.fecha_hora.substring(11, 16);
                    return fechaCita === fechaMencionada && horaCita === horaMencionada;
                  });
                  if (citaAMover) console.log('✅ Cita encontrada por fecha+hora extraída del texto:', fechaMencionada, horaMencionada);
                } else if (fechaMencionada) {
                  const citasDeFecha = todasLasCitas.filter(c => 
                    c.fecha_hora?.startsWith(fechaMencionada)
                  );
                  if (citasDeFecha.length === 1) {
                    citaAMover = citasDeFecha[0];
                    console.log('✅ Cita encontrada por fecha (única cita ese día):', fechaMencionada);
                  }
                }
              }

              // Estrategia D: Listar citas y pedir clarificación
              if (!citaAMover) {
                if (todasLasCitas.length > 1) {
                  const listaCitas = todasLasCitas.map((c, i) => {
                    const fecha = c.fecha_hora ? c.fecha_hora.split('T')[0] : '';
                    const hora = c.fecha_hora ? c.fecha_hora.substring(11, 16) : '';
                    return `${i + 1}. ${c.servicio_aux} el ${formatearFecha(fecha)} a las ${formatearHora(hora)} con ${c.especialista_nombre}`;
                  }).join('\n');

                  mensajeAccion = `Veo que tienes ${todasLasCitas.length} citas confirmadas:\n${listaCitas}\n\n¿Cuál quieres mover? Responde con el número o dime el servicio y la hora. 💫`;
                  accionEjecutada = true;
                } else if (todasLasCitas.length === 1) {
                  citaAMover = todasLasCitas[0];
                  console.log('⚠️ Fallback a única cita disponible:', citaAMover.fecha_hora, citaAMover.servicio_aux);
                }
              }

              // Ejecutar reagendamiento
              if (!citaAMover && !accionEjecutada) {
                mensajeAccion = "No pude identificar cuál cita quieres mover. ¿Me dices el servicio y la hora de la cita actual? 💫";
                accionEjecutada = true;
              } else if (citaAMover) {
                // USAR LOS DATOS REALES DE LA CITA EXISTENTE
                const servicioActual = servicios?.find(s => s.id === citaAMover.servicio_id) || {
                  id: null,
                  nombre: citaAMover.servicio_aux || "Servicio",
                  precio: 0,
                  duracion: citaAMover.duracion_aux || 60
                };

                const especialistaOriginal = citaAMover.especialista_nombre;
                const especialistaIdOriginal = citaAMover.especialista_id;
                let especialistaFinal = especialistaOriginal;
                let especialistaIdFinal = especialistaIdOriginal;

                if (datosExtraidos.cita_especialista) {
                  const espSolicitado = especialistas?.find(e =>
                    e.nombre.toLowerCase() === datosExtraidos.cita_especialista.toLowerCase()
                  );
                  if (espSolicitado) {
                    especialistaFinal = espSolicitado.nombre;
                    especialistaIdFinal = espSolicitado.id;
                  }
                }

                console.log('🔄 Reagendando:', {
                  citaId: citaAMover.id,
                  servicio: servicioActual.nombre,
                  de: citaAMover.fecha_hora,
                  a: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                  especialista: especialistaFinal
                });

                const disponible = await verificarDisponibilidad(
                  fechaFinal,
                  datosExtraidos.cita_hora,
                  especialistaFinal,
                  servicioActual.duracion
                );

                if (!disponible.ok) {
                  const alternativa = await buscarAlternativa(
                    fechaFinal,
                    datosExtraidos.cita_hora,
                    especialistaFinal,
                    servicioActual.duracion
                  );
                  mensajeAccion = `${disponible.mensaje} ${alternativa.mensaje}`;
                } else {
                  const fechaAnterior = citaAMover.fecha_hora ? citaAMover.fecha_hora.split('T')[0] : '';
                  const horaAnterior = citaAMover.fecha_hora ? citaAMover.fecha_hora.substring(11, 16) : '';

                  const { data: updateData, error: updateError } = await supabase
                    .from('citas')
                    .update({
                      fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                      estado: 'Confirmada',
                      especialista_id: especialistaIdFinal,
                      nombre_cliente_aux: `${clienteNombre} ${clienteApellido}`.trim(),
                      servicio_id: citaAMover.servicio_id,
                      servicio_aux: citaAMover.servicio_aux,
                      duracion_aux: citaAMover.duracion_aux
                    })
                    .eq('id', citaAMover.id)
                    .select();

                  if (updateError) {
                    console.error('❌ Error update Supabase:', updateError);
                    mensajeAccion = "Tuvimos un problema moviendo tu cita. ¿Lo intentamos de nuevo? 🙏";
                  } else if (!updateData || updateData.length === 0) {
                    console.error('❌ Supabase update retornó 0 filas afectadas para cita ID:', citaAMover.id);
                    mensajeAccion = "No pude encontrar la cita para actualizarla. ¿Me confirmas los datos por favor? 🙏";
                  } else {
                    console.log('✅ Supabase actualizado correctamente, filas:', updateData.length);

                    const airtableRes = await actualizarCitaAirtable(citaAMover.id, {
                      fecha: fechaFinal,
                      hora: datosExtraidos.cita_hora,
                      especialista: especialistaFinal,
                      observaciones: `Reagendada de ${fechaAnterior} ${horaAnterior} a ${fechaFinal} ${datosExtraidos.cita_hora}`,
                      telefono: userPhone,
                      fechaAnterior,
                      horaAnterior,
                      especialistaAnterior: especialistaOriginal
                    });

                    if (airtableRes.ok) {
                      mensajeAccion = `✨ ¡Cita movida con éxito!\n\nDe: ${formatearFecha(fechaAnterior)} ${formatearHora(horaAnterior)}\nA: 📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(datosExtraidos.cita_hora)}\n💇‍♀️ ${servicioActual.nombre} con ${especialistaFinal}\n\n¡Nos vemos pronto! 🌸`;
                    } else {
                      console.error('⚠️ Airtable falló pero Supabase sí se actualizó');
                      mensajeAccion = `✅ Tu cita de ${servicioActual.nombre} fue movida a ${formatearFecha(fechaFinal)} a las ${formatearHora(datosExtraidos.cita_hora)} con ${especialistaFinal}.\n\nNota: Estamos sincronizando con nuestro calendario secundario. 💫`;
                    }
                  }
                }
                accionEjecutada = true;
              }
            }
          }
        }

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: CANCELAR
        // ═══════════════════════════════════════════════════════
        else if (accion === 'cancelar') {
          const clienteId = cliente?.id;
          const clienteNombre = cliente?.nombre || datosExtraidos.nombre || '';
          const clienteApellido = cliente?.apellido || datosExtraidos.apellido || '';

          let citaACancelar = null;
          let todasLasCitas = [];

          if (clienteId) {
            const { data: citasPorId } = await supabase
              .from('citas')
              .select('id, servicio_aux, fecha_hora, especialista_id')
              .eq('cliente_id', clienteId)
              .eq('estado', 'Confirmada')
              .order('fecha_hora', { ascending: true })
              .limit(10);

            if (citasPorId?.length) todasLasCitas = citasPorId;
          }

          if (!todasLasCitas.length) {
            const nombreBusqueda = `${clienteNombre} ${clienteApellido}`.trim();
            if (nombreBusqueda) {
              const { data: citasPorNombre } = await supabase
                .from('citas')
                .select('id, servicio_aux, fecha_hora, especialista_id')
                .ilike('nombre_cliente_aux', `%${nombreBusqueda}%`)
                .eq('estado', 'Confirmada')
                .order('fecha_hora', { ascending: true })
                .limit(10);

              if (citasPorNombre?.length) todasLasCitas = citasPorNombre;
            }
          }

          const { data: espDataCancel } = await supabase.from('especialistas').select('id, nombre');
          const mapaEspCancel = {};
          (espDataCancel || []).forEach(e => { mapaEspCancel[e.id] = e.nombre; });

          todasLasCitas = todasLasCitas.map(c => ({
            ...c,
            especialista_nombre: mapaEspCancel[c.especialista_id] || 'Asignar'
          }));

          if (todasLasCitas.length > 0) {
            if (datosExtraidos.cita_servicio) {
              citaACancelar = todasLasCitas.find(c =>
                c.servicio_aux?.toLowerCase().includes(datosExtraidos.cita_servicio.toLowerCase())
              );
            }
            if (!citaACancelar) citaACancelar = todasLasCitas[0];
          }

          if (!citaACancelar) {
            mensajeAccion = "No encontré citas activas a tu nombre para cancelar. ¿Necesitas agendar una? 💫";
          } else {
            const fechaCita = citaACancelar.fecha_hora ? citaACancelar.fecha_hora.split('T')[0] : '';
            const horaCita = citaACancelar.fecha_hora ? citaACancelar.fecha_hora.substring(11, 16) : '';

            const { error: cancelError } = await supabase
              .from('citas')
              .update({
                estado: 'Cancelada',
                motivo_cancelacion: datosExtraidos.motivo || 'Cancelada por cliente via WhatsApp'
              })
              .eq('id', citaACancelar.id);

            if (cancelError) {
              console.error('❌ Error cancel Supabase:', cancelError);
              mensajeAccion = "Tuvimos un problema cancelando tu cita. ¿Me das un momento? 🙏";
            } else {
              await cancelarCitaAirtable(citaACancelar.id, datosExtraidos.motivo || 'Cancelada por cliente', {
                telefono: userPhone,
                fecha: fechaCita,
                hora: horaCita,
                especialista: citaACancelar.especialista_nombre
              });

              mensajeAccion = `✅ Tu cita de ${citaACancelar.servicio_aux || 'servicio'} del ${formatearFecha(fechaCita)} con ${citaACancelar.especialista_nombre} ha sido cancelada.\n\nLamentamos no verte esta vez, pero aquí estaremos cuando nos necesites. 🌸`;
            }
          }
          accionEjecutada = true;
        }

      } catch (e) {
        console.error('Error procesando JSON:', e.message);
      }
    }

    // ── Limpiar respuesta y guardar conversación ──
    let cleanReply = fullReply.split(/DATA_JSON|\`\`\`json/i)[0].trim();

    if (accionEjecutada && mensajeAccion) {
      cleanReply = mensajeAccion;
    }

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error General:', err.message);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problemita técnico. ¿Me das un segundito? 🌸</Message></Response>');
  }
}
