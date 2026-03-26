import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Citas';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log('📞 Teléfono:', userPhone);
  
  try {
    // 1. TRANSCRIPCIÓN
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post(
        "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, 
        { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }}
      );
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      console.log('🎤 Audio transcrito:', textoUsuario);
    } else {
      console.log('💬 Texto recibido:', textoUsuario);
    }

    // 2. CARGAR CLIENTE
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .single();

    if (clienteError && clienteError.code !== 'PGRST116') {
      console.error('Error Supabase:', clienteError);
    }

    const esClienteNuevo = !cliente;
    console.log('👤 Cliente nuevo:', esClienteNuevo, cliente ? `(Nombre: ${cliente.nombre})` : '');

    // 3. CATÁLOGO
    const { data: esp } = await supabase.from('especialistas').select('nombre');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = serv?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "nuestros servicios";
    
    const serviciosMap = {};
    serv?.forEach(s => {
      serviciosMap[s.nombre.toLowerCase()] = { precio: s.precio, duracion: s.duracion || 60 };
    });

    // 4. SYSTEM PROMPT CORREGIDO - Acepta fechas naturales y las convierte
    const systemPrompt = `Eres la Asistente de AuraSync. ${
      esClienteNuevo 
        ? `Este es un CLIENTE NUEVO (teléfono ${userPhone}). Saluda cordialmente y pide: Nombre, Apellido y Fecha de Nacimiento (acepta formatos como "27 de mayo del 76", "15/03/1990", etc. TÚ debes convertirlas internamente a YYYY-MM-DD). NO agendes nada hasta tener estos 3 datos.` 
        : `Este es el cliente ${cliente.nombre} ${cliente.apellido || ''}. Salúdalo por su nombre y ofrece agendar directamente.`
    }

SERVICIOS: ${catalogo}
ESPECIALISTAS: ${listaEsp}

INSTRUCCIONES CRÍTICAS:
1. Si el usuario da datos personales (ej: "Chris Ingwaz 27 de mayo del 76"), EXTRAE:
   - nombre: "Chris"
   - apellido: "Ingwaz" 
   - fecha_nacimiento: CONVIERTE a "1976-05-27" (YYYY-MM-DD)
2. Si ya tienes los datos personales y el usuario pide una cita (ej: "quiero corte mañana a las 3"), EXTRAE:
   - cita_fecha: CONVIERTE "mañana" a fecha real (YYYY-MM-DD)
   - cita_hora: CONVIERTE "3 de la tarde" a "15:00" (24h)
   - cita_servicio: "Corte de Cabello Premium"
   - cita_especialista: "Cualquiera" o el nombre si lo menciona

FORMATO JSON OBLIGATORIO al final de tu respuesta:
DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "...",
  "cita_hora": "...",
  "cita_servicio": "...",
  "cita_especialista": "..."
}:DATA_JSON`;

    // 5. RESPUESTA IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt }, 
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    console.log('🤖 Respuesta IA:', fullReply.substring(0, 100) + '...');

    // 6. EXTRACCIÓN JSON ROBUSTA
    let datosExtraidos = {};
    const jsonMatch = fullReply.match(/DATA_JSON:\s*(\{[\s\S]*?\})\s*:DATA_JSON/);
    
    if (jsonMatch) {
      try {
        // Limpiar el JSON de saltos de línea y espacios extra
        let jsonStr = jsonMatch[1]
          .replace(/\n/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/,\s*}/g, '}') // Eliminar comas trailing
          .trim();
        
        console.log('📋 JSON extraído:', jsonStr);
        datosExtraidos = JSON.parse(jsonStr);
        
        // 7. GUARDAR DATOS PERSONALES EN SUPABASE
        const tieneDatosValidos = datosExtraidos.nombre && 
                                  datosExtraidos.nombre !== "..." && 
                                  datosExtraidos.nombre !== "" &&
                                  datosExtraidos.apellido && 
                                  datosExtraidos.apellido !== "...";
        
        if (tieneDatosValidos) {
          console.log('💾 Guardando en Supabase:', {
            telefono: userPhone,
            nombre: datosExtraidos.nombre,
            apellido: datosExtraidos.apellido,
            fecha: datosExtraidos.fecha_nacimiento
          });
          
          const { error: upsertError } = await supabase
            .from('clientes')
            .upsert({
              telefono: userPhone,
              nombre: datosExtraidos.nombre.trim(),
              apellido: datosExtraidos.apellido.trim(),
              fecha_nacimiento: (datosExtraidos.fecha_nacimiento && datosExtraidos.fecha_nacimiento !== "...") 
                ? datosExtraidos.fecha_nacimiento 
                : null
            }, { onConflict: 'telefono' });
            
          if (upsertError) {
            console.error('❌ Error guardando cliente:', upsertError);
          } else {
            console.log('✅ Cliente guardado correctamente');
          }
        } else {
          console.log('⚠️ Datos incompletos, no se guarda:', datosExtraidos);
        }

        // 8. CREAR CITA EN AIRTABLE
        if (datosExtraidos.cita_fecha && 
            datosExtraidos.cita_fecha !== "..." && 
            datosExtraidos.cita_hora && 
            datosExtraidos.cita_hora !== "..." &&
            AIRTABLE_BASE_ID && 
            AIRTABLE_TOKEN) {
          
          const servicioKey = datosExtraidos.cita_servicio?.toLowerCase();
          const infoServicio = serviciosMap[servicioKey] || { precio: 0, duracion: 60 };
          
          await crearCitaAirtable({
            telefono: userPhone,
            nombre: datosExtraidos.nombre || cliente?.nombre,
            apellido: datosExtraidos.apellido || cliente?.apellido,
            esPrimeraVez: esClienteNuevo,
            fecha: datosExtraidos.cita_fecha,
            hora: datosExtraidos.cita_hora,
            servicio: datosExtraidos.cita_servicio,
            especialista: datosExtraidos.cita_especialista,
            precio: infoServicio.precio,
            duracion: infoServicio.duracion,
            notas: `Agendado por WhatsApp`
          });
        }
      } catch (e) {
        console.error('❌ Error procesando JSON:', e.message);
        console.error('JSON problemático:', jsonMatch[1]);
      }
    } else {
      console.log('⚠️ No se encontró bloque DATA_JSON en la respuesta');
    }

    // Limpiar respuesta
    const cleanReply = fullReply.replace(/DATA_JSON:[\s\S]*?:DATA_JSON/, '').trim();
    
    // Guardar conversación
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error general:', err);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Hubo un inconveniente técnico, ¿me repites?</Message></Response>');
  }
}

async function crearCitaAirtable(datos) {
  try {
    const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.trim();
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    
    console.log('🔗 Enviando a Airtable:', url);
    
    await axios.post(
      url,
      {
        records: [{
          fields: {
            "Cliente": nombreCompleto || "Sin nombre",
            "Servicio": datos.servicio || "No especificado",
            "Fecha": datos.fecha,
            "Especialista": datos.especialista || "No asignado",
            "Teléfono": datos.telefono,
            "Estado": "Confirmada",
            "Notas de la cita": datos.notas,
            "Email de cliente": "",
            "¿Es primera vez?": datos.esPrimeraVez ? "Sí" : "No",
            "Cliente VIP": "No",
            "Duración estimada (minutos)": parseInt(datos.duracion) || 60,
            "Importe estimado": parseFloat(datos.precio) || 0,
            "Observaciones de confirmación": new Date().toLocaleString('es-ES')
          }
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Cita creada en Airtable');
  } catch (error) {
    console.error('❌ Error Airtable:', error.response?.data || error.message);
  }
}
