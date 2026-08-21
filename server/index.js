import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import routes from './routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files for uploads — ensure both public/uploads/ and dist/uploads/ work
const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
const distUploadsDir = path.join(__dirname, '..', 'dist', 'uploads');
[uploadsDir, distUploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
app.use('/uploads', express.static(uploadsDir));

// Also serve public directory as static for any build-time assets
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// API routes
app.use('/api', routes);

// Serve built frontend in production
if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, '..', 'dist');
  // Ensure uploaded images are reachable from dist as well
  app.use('/uploads', express.static(distUploadsDir));
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  📦 库存管理系统已启动`);
  console.log(`  🌐 访问地址: http://localhost:${PORT}`);
  console.log(`  📱 局域网访问: http://<本机IP>:${PORT}\n`);
});
