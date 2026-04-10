import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const TIMEZONE = 'America/Guayaquil';

// --- FUNCIONES DE APOYO ---

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '0');
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '0');
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '0');
  const fecha = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO || 'fecha por confirmar';
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

async function obtenerOcupacionGlobal() {
  try {
    const hoy = getFechaEcuador();
    const mañana = getFechaEcuador(1);
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`OR(IS_SAME({Fecha}, '${hoy}', 'day'), IS_SAME({Fecha}, '${mañana}', 'day'))`);
    const res = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    const ocupados = res.data.records.filter((r) => r.fields.Estado === 'Confirmada').map((r) => `${r.fields.Especialista} ocupado el ${formatearFecha(r.fields.Fecha.split('T')[0])} a las ${r.fields.Hora}`).join('\n');
    return ocupados || "No hay citas ocupadas. Todo el equipo está libre.";
  } catch (e) { return "No hay ocupación registrada."; }
}

async function buscarCitasUsuario(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const res = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    return res.data.records.map((r) => ({ id: r.id, servicio: r.fields.Servicio, hora: r.fields.Hora, fecha: r.fields.Fecha.split('T')[0], especialista: r.fields.Especialista }));
  } catch (e) { return []; }
}

// --- HANDLER PRINCIPAL ---

app.post('/api/whatsapp', async (req, res) => {
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = (From || '').replace('whatsapp:', '').trim();

  try {
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", { url: MediaUrl0 }, { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` } });
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // CORRECCIÓN CRÍTICA: Definición explícita de cliente
    let cliente = null;
    const supabaseRes = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    if (supabaseRes.data) {
      cliente = supabaseRes.data;
    }

    const citasUsuario = await buscarCitasUsuario(userPhone);
    const ocupacionGlobal = await obtenerOcupacionGlobal();
    
    const infoCitas = citasUsuario.length > 0 
      ? citasUsuario.map((c) => `- Tienes ${c.servicio} con ${c.especialista} el ${formatearFecha(c.fecha)} a las ${c.hora} (ID: ${c.id})`).join('\n')
      : "No tienes citas agendadas.";

    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    const listaEsp = especialistas?.map(e => `${e.nombre} (${e.expertise})`).join(', ');
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ');

    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Concierge de lujo.

[FECHAS DE REFERENCIA]
- Hoy es: ${formatearFecha(getFechaEcuador())} (${getFechaEcuador()})
- Mañana es: ${formatearFecha(getFechaEcuador(1))} (${getFechaEcuador(1)})

[ESPECIALISTAS Y SERVICIOS]
- Equipo: ${listaEsp}
- Catálogo: ${catalogo}

[CITAS ACTUALES DEL CLIENTE]
${infoCitas}

[OCUPACIÓN REAL DE LA AGENDA (NO INVENTAR)]
${ocupacionGlobal}

[IDENTIDAD Y REGLAS]
- Si el cliente quiere REAGENDAR, usa el ID de su cita actual. MANTÉN el mismo servicio y especialista a menos que pida cambiarlos.
- Antes de decir que alguien está ocupado, mira la [OCUPACIÓN REAL]. Si no aparece en la lista, está LIBRE.
- FLUJO HUMANO: Divide respuestas con "###". Ejemplo: "Claro, verifico... ### Listo, te cambié la cita."
- NUNCA escribas el checkmark (✅) tú misma.
- DATA_JSON debe ser preciso. Si es reagendar, pon "accion": "reagendar" y el "cita_id" correcto.
- IMPORTANTE: Si recomiendas a un especialista, la acción DEBE ser "none". Primero asesora y pregunta "¿Te gustaría que agende?". SOLO usa "agendar" cuando el cliente confirme.

[DATA_JSON ESTRUCTURA]
DATA_JSON:{ "accion": "none"|"agendar"|"cancelar"|"reagendar", "cita_id": "...", "cita_fecha": "YYYY-MM-DD", "cita_hora": "HH:MM", "cita_servicio": "...", "cita_especialista": "..." }`;

    const messages = [{ role: "system", content: systemPrompt }];
    const { data: historial } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
    if (historial) historial.reverse().forEach(msg => messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', { model: "gpt-4o", messages, temperature: 0.2 }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` } });
    let fullReply = aiRes.data.choices[0].message.content;
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    let datosExtraidos = {};
    let mensajeAccion = '';
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        const accion = datosExtraidos.accion || 'none';
        const fechaFinal = datosExtraidos.cita_fecha || getFechaEcuador();

        if (accion === 'cancelar') {
          const res = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
          mensajeAccion = res ? "✅ Cita cancelada y eliminada de la agenda." : "No encontré la cita para cancelar.";
        }
        else if (accion === 'reagendar') {
          const res = await reagendarCitaAirtable(userPhone, datosExtraidos);
          mensajeAccion = res ? `✅ Cita reprogramada para el ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora}.` : "No pude reprogramar.";
        }
        else if (accion === 'agendar') {
          let serv = servicios?.find(s => s.nombre.toLowerCase().includes((datosExtraidos.cita_servicio || '').toLowerCase())) || { nombre: datosExtraidos.cita_servicio, precio: 0, duracion: 60 };
          const disp = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, serv.duracion);
          if (!disp.ok) {
            const alt = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, serv.duracion);
            mensajeAccion = `Ese horario no está disponible. ${alt.mensaje}`;
          } else {
            const res = await crearCitaAirtable({ telefono: userPhone, nombre: cliente?.nombre || datosExtraidos.nombre, fecha: fechaFinal, hora: datosExtraidos.cita_hora, servicio: serv.nombre, especialista: disp.especialista, precio: serv.precio, duracion: serv.duracion });
            if (res) mensajeAccion = `✅ Cita confirmada: ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora} con ${disp.especialista}.`;
          }
        }
      } catch (e) { console.error('Error JSON:', e.message); }
    }

    if (mensajeAccion) cleanReply = `${cleanReply}\n\n${mensajeAccion}`;
    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);

    const xmlMessages = cleanReply.split('###').map(msg => `<Message>${msg.trim()}</Message>`).join('');
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response>${xmlMessages}</Response>`);

  } catch (err) {
    console.error('Error General:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento de distracción. 🌸</Message></Response>');
  }
});

// --- FUNCIONES DE AIRTABLE ---

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    const payload = { records: [{ fields: { "Cliente": datos.nombre, "Servicio": datos.servicio, "Fecha": fechaUTC, "Hora": datos.hora, "Especialista": datos.especialista, "Teléfono": datos.telefono, "Estado": "Confirmada", "Importe estimado": datos.precio, "Duración estimada (minutos)": datos.duracion } }] };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (error) { return false; }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    let recordId = citaId;
    if (!recordId) {
      const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
      const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
      if (busqueda.data.records.length === 0) return false;
      recordId = busqueda.data.records[0].id;
    }
    await axios.delete(`${url}/${recordId}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    return true;
  } catch (error) { return false; }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    if (busqueda.data.records.length === 0) return false;
    
    const oldRecord = busqueda.data.records.find((r) => r.id === datos.cita_id) || busqueda.data.records[0];
    const recordId = oldRecord.id;
    
    // 1. Borramos la vieja físicamente
    await axios.delete(`${url}/${recordId}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    
    // 2. Creamos la nueva con los datos actualizados
    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    
    const payload = {
      records: [{
        fields: {
          "Cliente": oldRecord.fields.Cliente,
          "Servicio": oldRecord.fields.Servicio,
          "Fecha": fechaUTC,
          "Hora": datos.cita_hora,
          "Especialista": datos.cita_especialista || oldRecord.fields.Especialista,
          "Teléfono": telefono,
          "Estado": "Confirmada",
          "Importe estimado": oldRecord.fields["Importe estimado"],
          "Duración estimada (minutos)": oldRecord.fields["Duración estimada (minutos)"]
        }
      }]
    };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    
    return true;
  } catch (error) { return false; }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialista, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    const citas = response.data.records;
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracion || 60);
    for (const cita of citas) {
      const [he, me] = cita.fields.Hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + (cita.fields['Duración estimada (minutos)'] || 60);
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialista || cita.fields.Especialista === especialista) return { ok: false };
      }
    }
    return { ok: true, especialista: especialista || 'Asignar' };
  } catch (error) { return { ok: true }; }
}

async function buscarAlternativaAirtable(fecha, hora, especialista, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` } });
    const ocupados = response.data.records.map((c) => ({ hora: c.fields.Hora, duracion: c.fields['Duración estimada (minutos)'] || 60, especialista: c.fields.Especialista }));
    const [h, m] = hora.split(':').map(Number);
    let prop = h * 60 + m;
    while (prop <= 1080 - duracion) {
      let conf = false;
      for (const o of ocupados) {
        const [ho, mo] = o.hora.split(':').map(Number);
        if (prop < (ho * 60 + mo + o.duracion) && (prop + duracion) > (ho * 60 + mo)) {
          if (!especialista || o.especialista === especialista) { conf = true; break; }
        }
      }
      if (!conf) {
        const hStr = `${Math.floor(prop/60).toString().padStart(2,'0')}:${(prop%60).toString().padStart(2,'0')}`;
        return { mensaje: `¿Te funciona a las ${hStr}?`, hora: hStr };
      }
      prop += 15;
    }
    return { mensaje: "Día completo." };
  } catch (error) { return { mensaje: "¿Otro horario?" }; }
}

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on port 3000');
});
