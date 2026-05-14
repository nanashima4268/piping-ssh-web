const { webkit, chromium } = require('playwright');

async function runTest(browserType, name) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:8081/', { waitUntil: 'networkidle', timeout: 30000 });
  
  // Check that the unsupported warning is GONE
  const warningVisible = await page.locator('text=Sorry, this browser is not supported').isVisible().catch(() => false);
  
  // Fill form and check Connect button
  await page.locator('input[type="text"]').last().fill('testuser');
  await page.waitForTimeout(500);
  const connectBtn = page.locator('.v-btn:has-text("Connect")');
  const btnClass = await connectBtn.getAttribute('class').catch(() => '');
  const isDisabled = btnClass.includes('v-btn--disabled');
  
  // Wait for async supportsRequestStreams to resolve
  await page.waitForTimeout(1000);
  const serverCommand = await page.locator('textarea').first().inputValue().catch(() => 'N/A');
  const isChunkedCommand = serverCommand.includes('while true') && serverCommand.includes('mktemp');
  const isStreamingCommand = serverCommand.includes('curl -sSN') && !serverCommand.includes('while true');

  console.log(`\n=== ${name} ===`);
  console.log(`Warning visible (should be false): ${warningVisible}`);
  console.log(`Connect button disabled due to browser check (should be false): ${isDisabled}`);
  console.log(`Is chunked command: ${isChunkedCommand}`);
  console.log(`Is streaming command: ${isStreamingCommand}`);
  console.log(`Server command:\n  ${serverCommand.substring(0, 200)}`);
  if (errors.length > 0) console.log(`Page errors:`, errors);
  
  await page.screenshot({ path: `/tmp/test-${name.toLowerCase()}.png`, fullPage: true });
  await browser.close();
  return { warningVisible, isDisabled, isChunkedCommand, isStreamingCommand };
}

(async () => {
  try {
    const webkitResult = await runTest(webkit, 'webkit');
    const chromiumResult = await runTest(chromium, 'chromium');

    console.log('\n=== SUMMARY ===');
    
    // WebKit: no warning, button not blocked by browser check, chunked command
    const webkitOk = !webkitResult.warningVisible && !webkitResult.isDisabled && webkitResult.isChunkedCommand;
    // Chromium: no warning, button not blocked by browser check, streaming command
    const chromiumOk = !chromiumResult.warningVisible && !chromiumResult.isDisabled && chromiumResult.isStreamingCommand;
    
    console.log(`WebKit: ${webkitOk ? '✅' : '❌'} (warning:${!webkitResult.warningVisible}, enabled:${!webkitResult.isDisabled}, chunked:${webkitResult.isChunkedCommand})`);
    console.log(`Chromium: ${chromiumOk ? '✅' : '❌'} (warning:${!chromiumResult.warningVisible}, enabled:${!chromiumResult.isDisabled}, streaming:${chromiumResult.isStreamingCommand})`);
    
    if (webkitOk && chromiumOk) {
      console.log('\n✅ All checks passed!');
    } else {
      console.log('\n❌ Some checks failed.');
      process.exit(1);
    }
  } catch(e) {
    console.error('Test error:', e.message);
    process.exit(1);
  }
})();
