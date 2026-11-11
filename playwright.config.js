import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:'./e2e',
  timeout:30_000,
  fullyParallel:false,
  workers:1,
  reporter:'list',
  use:{baseURL:'http://localhost:3000',headless:true,viewport:{width:1440,height:1100},screenshot:'only-on-failure'},
  webServer:{command:'npm start',url:'http://localhost:3000',reuseExistingServer:true,timeout:30_000},
});
