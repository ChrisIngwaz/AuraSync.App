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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 Transacción para: ${userPhone}`);

  try {
    // 1. PROCESAR AUDIO/TEXTO
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
        return res.status(200).send('<Response><Message>Lo siento, tuve un problema con el audio. ¿Podrías escribirme?</Message></Response>');
      }
    }

    // 2. CARGAR CLIENTE
    let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
    const esNuevo = !cliente?.nombre;

    // 3. RECUPERAR HISTORIAL
    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(6);
      if (mensajes) historialFiltrado = mensajes.reverse();
    }

    // 4. DATOS DE NEGOCIO Y AGENDA (BLOQUE CORREGIDO)
    const { data: especialistas } = await supabase.from('especialistas').select('id, nombre');
    const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

    const ahora = new Date();
    const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString();
    const finHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 23, 59, 59).toISOString();

    const { data: citasHoy } = await supabase
      .from('citas')
      .select('fecha_hora, especialista_id, servicios(duracion, nombre)')
      .eq('estado', 'confirmada')
      .gte('fecha_hora', inicioHoy)
      .lte('fecha_hora', finHoy);

    const agendaResumen = citasHoy?.map(c => {
      const h = new Date(c.fecha_hora).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false });
      const esp = especialistas.find(e => e.id === c.especialista_id)?.nombre || "Especialista";
      return `- ${esp} ocupado desde las ${h} (${c.servicios?.nombre})`;
    }).join('\n') || "Toda la agenda está disponible.";

    const listaEsp = especialistas?.map(e => e.nombre).join(', ');

    // 5. SYSTEM PROMPT (AURA CON VISIÓN DE AGENDA)
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil'
    }).format(ahora);

    const systemPrompt = `Tu nombre es Aura, asistente profesional de AuraSync. Eres la Guardiana de la Coherencia. Tu objetivo es una atención cálida, ejecutiva y humana. 

[REGLAS DE ORO]
1. SIN ESPERAS: Nunca digas "un momento", "déjame verificar" o "espera". Tú ya conoces la agenda. Responde directamente si hay espacio o no.
2. PROACTIVIDAD: Si el cliente no menciona a un especialista, presenta las opciones de forma humana. Ejemplo: "Para ese horario tengo disponibles a Carlos y Anita. Carlos es un experto en cortes precisos, mientras que Anita tiene una técnica increíble para el cuidado del cuero cabelludo. ¿Con quién te gustaría agendar?".
3. NATURALIDAD: Habla como una persona que gestiona el local, no como un software. Usa frases conectoras naturales.
4. PERSONALIDAD: Eres eficiente, sofisticada y cercana.

[ESTADO DE LA AGENDA HOY - ${hoyEcuador}]
${agendaResumen}

[ESPECIALISTAS DISPONIBLES]
${listaEsp} (Presenta a cada uno con una cualidad breve y profesional).

[ESTRUCTURA DE DATOS]
Llenar siempre el JSON al final de forma invisible.
DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "..."
}`;

    // 6. LLAMADA A OPENAI
    const messages = [{ role: "system", content: systemPrompt }];
    historialFiltrado.forEach(msg => messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", messages: messages, temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    // 7. PROCESAR JSON Y AGENDAR (BLOQUE DE INGENIERÍA CORREGIDO)
    let citaCreada = false;
    let mensajeError = "";
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        const datos = JSON.parse(jsonMatch[1].trim());
        
        // Upsert cliente
        if (datos.nombre && datos.nombre !== "..." && esNuevo) {
          const { data: nC } = await supabase.from('clientes').upsert({
            telefono: userPhone, nombre: datos.nombre, apellido: datos.apellido || ""
          }, { onConflict: 'telefono' }).select().single();
          if (nC) cliente = nC;
        }

        const tieneFecha = datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datos.cita_hora?.match(/^\d{2}:\d{2}$/);
        
        if (tieneFecha && tieneHora && (cliente?.nombre || datos.nombre)) {
          const servicioDb = servicios?.find(s => s.nombre.toLowerCase() === datos.cita_servicio.toLowerCase());
          const especialistaDb = especialistas?.find(e => e.nombre.toLowerCase() === datos.cita_especialista.toLowerCase());
          
          const duracion = servicioDb?.duracion || 30;
          const inicio = new Date(`${datos.cita_fecha}T${datos.cita_hora}:00-05:00`);
          const fin = new Date(inicio.getTime() + duracion * 60000);

          // VALIDACIÓN MATEMÁTICA DE SOLAPAMIENTO
          const disp = await verificarDisponibilidad(supabase, datos.cita_fecha, inicio, fin, especialistaDb?.id);
          
          if (disp.disponible) {
            const okAirtable = await crearCitaAirtable({
              telefono: userPhone, nombre: cliente?.nombre || datos.nombre,
              apellido: cliente?.apellido || datos.apellido || "",
              fecha: datos.cita_fecha, hora: datos.cita_hora,
              servicio: datos.cita_servicio, especialista: datos.cita_especialista,
              precio: servicioDb?.precio || 0
            });

            if (okAirtable) {
              await supabase.from('citas').insert({
                cliente_id: cliente?.id, servicio_id: servicioDb?.id,
                especialista_id: especialistaDb?.id, fecha_hora: inicio.toISOString(),
                estado: 'confirmada'
              });
              citaCreada = true;
            }
          } else {
            mensajeError = disp.mensaje;
          }
        }
      } catch (e) { console.error('Error JSON:', e); }
    }

    // 8. RESPUESTA FINAL
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) cleanReply += `\n\n✅ Tu cita ha sido agendada con éxito.`;
    else if (mensajeError) cleanReply += `\n\n⚠️ ${mensajeError}`;

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    return res.status(200).send('<Response><Message>Estoy experimentando una breve interrupción. ¿Podrías repetirme eso?</Message></Response>');
  }
}

// FUNCIONES AUXILIARES CORREGIDAS
async function verificarDisponibilidad(supabase, fecha, nuevoInicio, nuevoFin, especialistaId) {
  const inicioDia = new Date(`${fecha}T00:00:00-05:00`).toISOString();
  const finDia = new Date(`${fecha}T23:59:59-05:00`).toISOString();
  
  const { data: existentes } = await supabase.from('citas').select('fecha_hora, servicios(duracion), especialista_id')
    .eq('estado', 'confirmada').gte('fecha_hora', inicioDia).lte('fecha_hora', finDia);

  const chequearSolapamiento = (idEsp) => {
    const citas = existentes?.filter(c => c.especialista_id === idEsp) || [];
    return citas.some(c => {
      const exInicio = new Date(c.fecha_hora);
      const exFin = new Date(exInicio.getTime() + (c.servicios?.duracion || 30) * 60000);
      return (nuevoInicio < exFin && nuevoFin > exInicio); // Fórmula de solapamiento
    });
  };

  if (especialistaId) {
    if (chequearSolapamiento(especialistaId)) return { disponible: false, mensaje: "Ese horario ya está ocupado para ese especialista." };
  } else {
    const { data: espAll } = await supabase.from('especialistas').select('id');
    const algunoLibre = espAll.some(e => !chequearSolapamiento(e.id));
    if (!algunoLibre) return { disponible: false, mensaje: "No hay especialistas libres en ese horario." };
  }
  return { disponible: true };
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    await axios.post(url, {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio, "Fecha": datos.fecha, "Hora": datos.hora,
          "Especialista": datos.especialista, "Teléfono": datos.telefono,
          "Estado": "Confirmada", "Importe estimado": datos.precio
        }
      }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }});
    return true;
  } catch (e) { return false; }
}
