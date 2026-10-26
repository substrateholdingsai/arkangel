import React, { useEffect, useRef, useState } from 'react';
import { Shield, Lock, Cpu, Radio } from 'lucide-react';

interface SplineShieldHeroProps {
  splineUrl?: string;
}

export const SplineShieldHero: React.FC<SplineShieldHeroProps> = ({ splineUrl }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [useSplineEmbed] = useState(Boolean(splineUrl));
  const [activeLayer, setActiveLayer] = useState<'nom' | 'edge' | 'carrier'>('nom');

  // Interactive 3D Canvas Cryptographic Shield
  useEffect(() => {
    if (useSplineEmbed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let angle = 0;
    let innerAngle = 0;

    // High DPI support
    const resize = () => {
      if (!canvas || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    const hashes = [
      'SHA-256: 4f8a9b1c7e2d...',
      'NOM-151: ATEB-PSC-2026',
      'RFC 3161 TSA: CENAM',
      'CLOUDFLARE WORM R2',
      'TELNYX PSTN CARRIER',
      'C.COM ART 1298-A',
      'REDECO FAIL-CLOSED',
    ];

    const particles: Array<{
      x: number;
      y: number;
      size: number;
      speed: number;
      opacity: number;
      angle: number;
      radius: number;
    }> = [];
    for (let i = 0; i < 48; i++) {
      particles.push({
        x: 0,
        y: 0,
        size: Math.random() * 2 + 1,
        speed: (Math.random() * 0.008 + 0.003) * (Math.random() > 0.5 ? 1 : -1),
        opacity: Math.random() * 0.7 + 0.3,
        angle: Math.random() * Math.PI * 2,
        radius: Math.random() * 150 + 70,
      });
    }

    const render = () => {
      if (!canvas || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const centerX = width / 2 + mousePos.x * 25;
      const centerY = height / 2 + mousePos.y * 25;

      ctx.clearRect(0, 0, width, height);

      // Deep radial glow in emerald / slate
      const glowGrad = ctx.createRadialGradient(centerX, centerY, 10, centerX, centerY, 240);
      glowGrad.addColorStop(0, 'rgba(16, 185, 129, 0.16)');
      glowGrad.addColorStop(0.5, 'rgba(5, 150, 105, 0.05)');
      glowGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
      ctx.fillStyle = glowGrad;
      ctx.fillRect(0, 0, width, height);

      // Outer Cryptographic Ring (Rotating)
      angle += 0.005;
      innerAngle -= 0.007;

      ctx.save();
      ctx.translate(centerX, centerY);

      // Orbiting Data Particles
      particles.forEach((p) => {
        p.angle += p.speed;
        const px = Math.cos(p.angle) * p.radius;
        const py = Math.sin(p.angle) * (p.radius * 0.75);
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(52, 211, 153, ${p.opacity * 0.8})`;
        ctx.fill();
      });

      // Outer Ring
      ctx.beginPath();
      ctx.arc(0, 0, 175, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 10]);
      ctx.stroke();

      // Middle Dynamic Ring with Segments
      ctx.beginPath();
      ctx.arc(0, 0, 140, angle, angle + Math.PI * 1.4);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.75)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([18, 8, 4, 8]);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, 140, angle + Math.PI * 1.5, angle + Math.PI * 1.95);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Inner Counter-Rotating Hex Ring
      ctx.beginPath();
      ctx.arc(0, 0, 105, innerAngle, innerAngle + Math.PI * 1.8);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.stroke();

      // Draw Cryptographic Hash labels orbiting
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';
      hashes.forEach((text, idx) => {
        const itemAngle = angle + (idx * (Math.PI * 2)) / hashes.length;
        const hx = Math.cos(itemAngle) * 195;
        const hy = Math.sin(itemAngle) * 195 * 0.85;
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(itemAngle + Math.PI / 2);
        ctx.fillText(text, -text.length * 2.5, 0);
        ctx.restore();
      });

      // Core Shield Polygon (Hexagonal faceted glass look)
      ctx.setLineDash([]);
      ctx.beginPath();
      const shieldRadius = 75;
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 - Math.PI / 6;
        const x = Math.cos(a) * shieldRadius;
        const y = Math.sin(a) * shieldRadius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      // Shield Fill & Border
      const shieldGrad = ctx.createLinearGradient(-40, -60, 40, 60);
      shieldGrad.addColorStop(0, 'rgba(15, 23, 42, 0.92)');
      shieldGrad.addColorStop(0.5, 'rgba(30, 41, 59, 0.85)');
      shieldGrad.addColorStop(1, 'rgba(6, 78, 59, 0.75)');
      ctx.fillStyle = shieldGrad;
      ctx.fill();

      ctx.strokeStyle = 'rgba(52, 211, 153, 0.85)';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = 'rgba(16, 185, 129, 0.5)';
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Inner Core Emblem: Padlock + Balance Scale lines
      ctx.beginPath();
      ctx.arc(0, -10, 16, Math.PI, 0, false);
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 3.5;
      ctx.stroke();

      ctx.fillStyle = '#10b981';
      ctx.fillRect(-18, -10, 36, 30);

      // Keyhole
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-1.5, 0, 3, 10);

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
    };
  }, [useSplineEmbed, mousePos]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setMousePos({ x, y });
  };

  const handleMouseLeave = () => {
    setMousePos({ x: 0, y: 0 });
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="relative w-full max-w-xl mx-auto h-[460px] flex items-center justify-center select-none"
    >
      {/* Background Interactive Canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      {/* Floating Interactive HUD Tags */}
      <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4 z-10">
        {/* Top Floating Badge */}
        <div className="flex justify-between items-center">
          <div className="pointer-events-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/85 backdrop-blur-md border border-emerald-500/30 text-xs font-medium text-emerald-400 shadow-lg">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>Motor Legal Dual-Engine Activo</span>
          </div>

          <div className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900/80 backdrop-blur-md border border-slate-700/60 text-xs font-mono text-slate-300">
            <Lock className="w-3.5 h-3.5 text-emerald-400" />
            <span>ASN.1 DER · RFC 3161</span>
          </div>
        </div>

        {/* Bottom Floating Selector Cards */}
        <div className="pointer-events-auto grid grid-cols-3 gap-2 w-full pt-4">
          <button
            type="button"
            onClick={() => setActiveLayer('nom')}
            className={`p-2.5 rounded-lg border text-left transition-all ${
              activeLayer === 'nom'
                ? 'bg-slate-900/95 border-emerald-500/80 text-white shadow-md shadow-emerald-500/10'
                : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
              <Shield className="w-3 h-3" />
              <span>NOM-151</span>
            </div>
            <div className="text-[11px] mt-0.5 text-slate-300 font-sans leading-tight">
              Prueba Plena Judicial
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveLayer('edge')}
            className={`p-2.5 rounded-lg border text-left transition-all ${
              activeLayer === 'edge'
                ? 'bg-slate-900/95 border-emerald-500/80 text-white shadow-md shadow-emerald-500/10'
                : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-blue-400 uppercase tracking-wider">
              <Cpu className="w-3 h-3" />
              <span>Cloudflare</span>
            </div>
            <div className="text-[11px] mt-0.5 text-slate-300 font-sans leading-tight">
              Bóveda WORM 10 Años
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveLayer('carrier')}
            className={`p-2.5 rounded-lg border text-left transition-all ${
              activeLayer === 'carrier'
                ? 'bg-slate-900/95 border-emerald-500/80 text-white shadow-md shadow-emerald-500/10'
                : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
              <Radio className="w-3 h-3" />
              <span>Telnyx</span>
            </div>
            <div className="text-[11px] mt-0.5 text-slate-300 font-sans leading-tight">
              Telefonía Carrier Direct
            </div>
          </button>
        </div>
      </div>

      {/* Floating Center Overlay with dynamic detail popup */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none text-center">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 text-xs font-mono text-emerald-300 bg-slate-950/90 px-3 py-1 rounded border border-emerald-500/40">
          AR-HASH-VERIFIED
        </div>
      </div>
    </div>
  );
};
