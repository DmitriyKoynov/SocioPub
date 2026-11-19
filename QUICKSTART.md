# Быстрый старт

1. Установите Node.js 20.19+ или 22.12+ и зависимости:

   ```bash
   npm ci
   ```

2. Запустите демонстрацию:

   ```bash
   npm run dev
   ```

3. Откройте URL из терминала, введите любой непустой логин и пароль. Измените значения в таблице и воспользуйтесь экспортом в Excel.

4. Для проверки проекта выполните:

   ```bash
   npm test
   npm run build
   npm run preview
   ```

Для подключения к своему backend скопируйте `.env.example` в `.env.real.local`, задайте `API_PROXY_TARGET` и `VITE_APEX_APP_ID` и запустите `npm run prod`. Подробности и ограничения — в [README.md](README.md).
