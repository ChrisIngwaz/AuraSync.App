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

const TIMEZONE = 'America/Guayaquil';

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' };
  const partes = new Intl.DateTimeFormat('en-CA', opciones).formatToParts(ahora);
  
  const year = partes.find(p => p.type === 'year').value;
  const month = partes.find(p => p.type === 'month').value;
  const day = partes.find(p => p.type === 'day').value;
  
  const fecha = new Date(year, month - 1, day);
  fecha.setDate(fecha.getDate() + offsetDias);
  
  return fecha.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) {
    console.error('Fecha inválida:', fechaISO);
    return fechaISO || 'fecha por confirmar';
  }
  
  const [anio, mes, dia] = fechaISO.split('-');
  const fecha = new Date(parseInt(anio), parseInt(mes) - 1, parseInt(dia));
  
  return fecha.toLocaleDateString('es-EC', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: TIMEZONE
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  // ============ DEBUG TEMPORAL ============
  const debugFechas = {
    serverNow: new Date().toISOString(),
    serverDate: new Date().toDateString(),
    ecuadorDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }),
    ecuadorString: new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })
  };
  console.log('🔍 DEBUG FECHAS SERVIDOR:', JSON.stringify(debugFechas));
  // ============ FIN DEBUG ============

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 ${userPhone}`);

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
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Error con audio. Escribime por favor.</Message></Response>');
      }
    }

    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const esNuevo = !cliente?.nombre;

    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(6);
      
      if (mensajes) {
        historialFiltrado = mensajes.reverse();
      }
    } else {
      console.log('⚡ Cliente nuevo detectado.');
    }

    const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";

    const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Comunicación sofisticada, ejecutiva y proactiva.

[IDENTIDAD]
- Tono: Profesional, seguro, comercialmente astuto
- Proactividad: TOMA LA INICIATIVA en recomendaciones
- Cliente: ${cliente?.nombre || 'Nuevo Usuario'}

[CAPACIDADES]
Puedes: AGENDAR nuevas citas, CANCELAR citas existentes, REAGENDAR cambiando fecha/hora.

[RECOMENDACIONES]
- Especialistas: ${listaEsp}
- Servicios: ${catalogo}
- Destaca virtudes del equipo según expertise

[REGLAS DE ORO]
- NUNCA digas "No sé" o "Como usted prefiera"
- Evita lenguaje meloso. Negocios de alta gama.
- Si ya te dio un dato, úsalo para avanzar

[FECHAS IMPORTANTE]
- Hoy es: ${formatearFecha(getFechaEcuador())}
- Mañana es: ${formatearFecha(getFechaEcuador(1))}

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente:
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "...",
  "cita_id": "..."
}`;

    const messages = [{ role: "system", content: systemPrompt }];
    historialFiltrado.forEach(msg => {
      messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido });
    });
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;

    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
            if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        
        // ============ CORRECCIÓN FECHA DEFINITIVA v3 ============
        // Siempre calcular fecha basada en el texto del usuario, nunca confiar en OpenAI
        
        const textoLower = (textoUsuario || '').toLowerCase();
        const ahora = new Date();
        
        // Forzar cálculo en zona horaria Ecuador
        const opciones = { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' };
        const partes = new Intl.DateTimeFormat('en-CA', opciones).formatToParts(ahora);
        const year = parseInt(partes.find(p => p.type === 'year').value);
        const month = parseInt(partes.find(p => p.type === 'month').value) - 1;
        const day = parseInt(partes.find(p => p.type === 'day').value);
        
        // Calcular hoy y mañana en Ecuador
        const hoyEcuador = new Date(year, month, day);
        const mananaEcuador = new Date(year, month, day + 1);
        const pasadoManana = new Date(year, month, day + 2);
        
        const fechaHoyStr = hoyEcuador.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
        const fechaMananaStr = mananaEcuador.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
        const fechaPasadoStr = pasadoManana.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
        
        let fechaFinal;
        
        // Detectar intención en el texto del usuario (no en el JSON de OpenAI)
        if (textoLower.includes('mañana') || textoLower.includes('manana')) {
          fechaFinal = fechaMananaStr;
          console.log('✅ Detectado "mañana" en texto →', fechaFinal);
        }
        else if (textoLower.includes('pasado mañana')) {
          fechaFinal = fechaPasadoStr;
          console.log('✅ Detectado "pasado mañana" →', fechaFinal);
        }
        else if (textoLower.includes('hoy')) {
          fechaFinal = fechaHoyStr;
          console.log('✅ Detectado "hoy" →', fechaFinal);
        }
        // Si OpenAI generó una fecha que parece válida futura, usarla
        else if (datosExtraidos.cita_fecha && 
                 datosExtraidos.cita_fecha >= fechaHoyStr && 
                 datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
          fechaFinal = datosExtraidos.cita_fecha;
          console.log('✅ Usando fecha de OpenAI:', fechaFinal);
        }
        // Fallback: si OpenAI generó fecha pasada o inválida → mañana
        else {
          fechaFinal = fechaMananaStr;
          console.log('⚠️ Fecha inválida de OpenAI, forzando mañana:', fechaFinal);
        }
        
        console.log('📅 FECHA FINAL USADA:', fechaFinal);
        // ============ FIN CORRECCIÓN ============
        
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "..." && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || "",
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          cliente = { nombre: datosExtraidos.nombre, apellido: datosExtraidos.apellido || "" };
        }

        const accion = datosExtraidos.accion || 'none';
        
        if (accion === 'cancelar') {
          const resultado = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
          mensajeAccion = resultado 
            ? "✅ Cita cancelada exitosamente." 
            : "No encontré citas activas para cancelar.";
          accionEjecutada = true;
        }
        
        else if (accion === 'reagendar') {
          if (fechaFinal && datosExtraidos.cita_hora) {
            const resultado = await reagendarCitaAirtable(userPhone, { ...datosExtraidos, cita_fecha: fechaFinal });
            mensajeAccion = resultado 
              ? `✅ Cita reprogramada para ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora}.`
              : "No pude reprogramar. ¿Tienes una cita activa?";
            accionEjecutada = true;
          }
        }
        
        else if (accion === 'agendar' || (fechaFinal && datosExtraidos.cita_hora)) {
          const tieneFecha = fechaFinal.match(/^\d{4}-\d{2}-\d{2}$/);
          const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
          
          if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre)) {
            
            let servicioData = servicios?.find(s => 
              s.nombre.toLowerCase() === (datosExtraidos.cita_servicio || '').toLowerCase()
            ) || servicios?.find(s => 
              (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())
            ) || { nombre: datosExtraidos.cita_servicio || "Servicio", precio: 0, duracion: 60 };

            const disponible = await verificarDisponibilidadAirtable(
              fechaFinal,
              datosExtraidos.cita_hora,
              datosExtraidos.cita_especialista,
              servicioData.duracion
            );

            if (!disponible.ok) {
              const alternativa = await buscarAlternativaAirtable(
                fechaFinal,
                datosExtraidos.cita_hora,
                datosExtraidos.cita_especialista,
                servicioData.duracion,
                especialistas?.map(e => e.nombre)
              );
              
              mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
              accionEjecutada = true;
            } else {
              
              const nombreCliente = cliente?.nombre || datosExtraidos.nombre;
              const apellidoCliente = cliente?.apellido || datosExtraidos.apellido || "";
              const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
              
              // ============ CAMBIO 2: Usar fechaFinal en lugar de datosExtraidos.cita_fecha ============
              console.log('💾 Registrando en Supabase...');
              const { data: citaSupabase, error: errorSupabase } = await supabase
                .from('citas')
                .insert({
                  cliente_id: cliente?.id || null,
                  servicio_id: servicioData.id || null,
                  especialista_id: null,
                  fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                  estado: 'Confirmada',
                  nombre_cliente_aux: `${nombreCliente} ${apellidoCliente}`.trim(),
                  servicio_aux: servicioData.nombre,
                  duracion_aux: servicioData.duracion,
                  created_at: new Date().toISOString()
                })
                .select()
                .single();

              if (errorSupabase) {
                console.error('❌ Error Supabase:', errorSupabase);
              } else {
                console.log('✅ Supabase OK:', citaSupabase?.id);
              }

              // ============ CAMBIO 3: Usar fechaFinal en Airtable ============
              const citaAirtable = await crearCitaAirtable({
                telefono: userPhone,
                nombre: nombreCliente,
                apellido: apellidoCliente,
                fecha: fechaFinal,
                hora: datosExtraidos.cita_hora,
                servicio: servicioData.nombre,
                especialista: especialistaFinal,
                precio: servicioData.precio,
                duracion: servicioData.duracion,
                supabase_id: citaSupabase?.id || null
              });

              // ============ CAMBIO 3: Usar fechaFinal en mensaje ============
              if (citaAirtable) {
                mensajeAccion = `✅ Cita confirmada: ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora} con ${especialistaFinal}.`;
              } else {
                mensajeAccion = "Tuve un problema registrando la cita. ¿Lo intentamos de nuevo?";
              }
              accionEjecutada = true;
            }
          }
        }

      } catch (e) { 
        console.error('Error procesando JSON:', e.message); 
      }
    }

    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    
    if (accionEjecutada && mensajeAccion) {
      cleanReply = mensajeAccion;
    } else if (accionEjecutada) {
      cleanReply += `\n\n${mensajeAccion}`;
    }

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento de distracción. ¿Me repites por favor? 🌸</Message></Response>');
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": datos.fecha,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion,
          "ID_Supabase": datos.supabase_id || null
        }
      }]
    };
    await axios.post(url, payload, { 
      headers: { 
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });
    return true;
  } catch (error) { 
    console.error('Error Airtable:', error.message);
    return false; 
  }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return false;

    const recordId = citaId || busqueda.data.records[0].id;
    
    await axios.patch(`${url}`, {
      records: [{
        id: recordId,
        fields: { "Estado": "Cancelada" }
      }]
    }, {
      headers: { 
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });
    
    return true;
  } catch (error) {
    console.error('Error cancelando:', error.message);
    return false;
  }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (busqueda.data.records.length === 0) return false;

    const recordId = datos.cita_id || busqueda.data.records[0].id;
    
    await axios.patch(`${url}`, {
      records: [{
        id: recordId,
        fields: { 
          "Fecha": datos.cita_fecha,
          "Hora": datos.cita_hora,
          "Especialista": datos.cita_especialista || busqueda.data.records[0].fields.Especialista,
          "Estado": "Confirmada"
        }
      }]
    }, {
      headers: { 
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 
        'Content-Type': 'application/json' 
      }
    });
    
    return true;
  } catch (error) {
    console.error('Error reagendando:', error.message);
    return false;
  }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialistaSolicitado, duracionMinutos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const citas = response.data.records;
    
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracionMinutos || 60);

    if (inicioNuevo < 540) {
      return { ok: false, mensaje: "Nuestro horario comienza a las 9:00. ¿Te funciona?" };
    }
    if (finNuevo > 1080) {
      return { ok: false, mensaje: "Ese horario excede nuestra jornada (hasta 18:00). ¿Otra hora?" };
    }

    for (const cita of citas) {
      const horaExistente = cita.fields.Hora;
      const duracionExistente = cita.fields['Duración estimada (minutos)'] || 60;
      const espExistente = cita.fields.Especialista;
      
      const [he, me] = horaExistente.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + duracionExistente;
      
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialistaSolicitado || espExistente === especialistaSolicitado) {
          return { 
            ok: false, 
            mensaje: `${espExistente} no está disponible a las ${hora}. ¿Otra hora u otro especialista?`,
            conflicto: true 
          };
        }
      }
    }

    return { 
      ok: true, 
      especialista: especialistaSolicitado || (citas.length > 0 ? null : 'Asignar')
    };

  } catch (error) {
    console.error('Error verificando disponibilidad:', error.message);
    return { ok: true, especialista: especialistaSolicitado };
  }
}

async function buscarAlternativaAirtable(fecha, horaSolicitada, especialistaSolicitado, duracion, listaEspecialistas) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const citas = response.data.records;
    const ocupados = citas.map(c => ({
      hora: c.fields.Hora,
      duracion: c.fields['Duración estimada (minutos)'] || 60,
      especialista: c.fields.Especialista
    }));

    const [h, m] = horaSolicitada.split(':').map(Number);
    let horaPropuesta = h * 60 + m;
    
    while (horaPropuesta <= 1080 - duracion) {
      const finPropuesta = horaPropuesta + duracion;
      let conflicto = false;
      
      for (const ocup of ocupados) {
        const [ho, mo] = ocup.hora.split(':').map(Number);
        const inicioOcupado = ho * 60 + mo;
        const finOcupado = inicioOcupado + ocup.duracion;
        
        if (horaPropuesta < finOcupado && finPropuesta > inicioOcupado) {
          if (!especialistaSolicitado || ocup.especialista === especialistaSolicitado) {
            conflicto = true;
            break;
          }
        }
      }
      
      if (!conflicto) {
        const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
        return {
          mensaje: `¿Te funciona a las ${horaStr}?`,
          hora: horaStr
        };
      }
      
      horaPropuesta += 15;
    }

    return {
      mensaje: "Ese día está completo. ¿Otro día quizás?"
    };

  } catch (error) {
    return { mensaje: "¿Te funciona otro horario?" };
  }
}
