// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://bangk-shield.bangkah.tech',
  integrations: [
    starlight({
      title: 'Bangk-Shield',
      description:
        'Dokumentasi Bangk-Shield: honeypot application layer berbasis edge untuk Cloudflare Workers.',
      logo: {
        src: './src/assets/logo.svg',
        alt: 'Bangk-Shield',
      },
      favicon: '/favicon.svg',
      locales: {
        root: { label: 'Bahasa Indonesia', lang: 'id' },
      },
      disable404Route: true,
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Bangkah/Bangk-Shield',
        },
      ],
      lastUpdated: true,
      pagination: true,
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Mulai',
          items: [
            { slug: 'mulai/pendahuluan' },
            { slug: 'mulai/instalasi' },
            { slug: 'mulai/mulai-cepat' },
            { slug: 'mulai/deploy' },
            { slug: 'mulai/integrasi-cloudflare-pages' },
          ],
        },
        {
          label: 'Konsep',
          items: [
            { slug: 'konsep/arsitektur' },
            { slug: 'konsep/rule-engine' },
            { slug: 'konsep/watermark' },
            { slug: 'konsep/circuit-breaker' },
            { slug: 'konsep/logging' },
          ],
        },
        {
          label: 'Konfigurasi',
          items: [
            { slug: 'konfigurasi/rules' },
            { slug: 'konfigurasi/whitelist' },
            { slug: 'konfigurasi/wrangler' },
            { slug: 'konfigurasi/build-pipeline' },
          ],
        },
        {
          label: 'Referensi',
          items: [
            { slug: 'referensi/api' },
            { slug: 'referensi/respons' },
            { slug: 'referensi/modul' },
            { slug: 'referensi/struktur-proyek' },
            { slug: 'referensi/batas-kemampuan' },
          ],
        },
        {
          label: 'Pengembangan',
          items: [
            { slug: 'pengembangan/skenario-pengujian' },
            { slug: 'pengembangan/riwayat-perbaikan' },
          ],
        },
      ],
    }),
  ],
});
