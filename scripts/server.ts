/**
 * Servidor HTTP simples para rodar o Bob fora da Vercel (no seu computador ou no Docker).
 * Usa exatamente o mesmo handler de api/webhook.ts.
 *
 *   npm run server   ->  http://localhost:3000/api/webhook
 */
import { createServer } from 'node:http';
import { GET, POST } from '../api/webhook.js';

const port = Number(process.env.PORT || 3000);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/api/webhook') {
      res.writeHead(404).end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    // Fora da Vercel o waitUntil não segura a requisição; o processamento
    // continua em segundo plano porque o servidor fica sempre de pé.
    const response = req.method === 'POST' ? await POST(request) : await GET();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('erro');
  }
}).listen(port, () => console.log(`Bob ouvindo em http://localhost:${port}/api/webhook`));
