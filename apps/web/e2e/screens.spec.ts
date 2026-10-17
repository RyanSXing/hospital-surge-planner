import {test,expect} from '@playwright/test';
import {api,assertPageHealthy,capture,open,record,scenario,waitRun} from './helpers';
test('all seven screens render actual run context and keyboard navigation',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const context=await scenario(page,'screen audit',{horizon_calendar_days:2,replications:2});const queued=await api(page.request,'/run-groups','POST',{scenario_id:context.scenario.id});const run=await waitRun(page,queued.id);
 const views=['overview','scenarios','patients','resources','compare','replay','data'];const audit=[];
 for(const view of views){await open(page,context.scenario.id,view,run.id);await expect(page.locator('.statusbar')).toContainText('2 completed runs');if(view==='patients'){await expect(page.getByText('Selected simulation trajectory',{exact:true})).toBeVisible();await expect(page.locator('.patient-census tbody tr')).not.toHaveCount(0);}if(view==='replay')await expect(page.locator('.replay-summary')).toContainText('84 active patients');await expect(page.locator('.state-banner')).toHaveCount(0);if(view==='data')await expect(page.getByRole('button',{name:'Export dataset',exact:true})).toBeEnabled();await page.waitForTimeout(500);await assertPageHealthy(page);await capture(page,view,info);audit.push({view,scenario:context.scenario.id,run:run.id,title:await page.locator('h1').allTextContents(),viewport:page.viewportSize()});}
 await open(page,context.scenario.id,'overview',run.id);await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to workspace'})).toBeFocused();await page.keyboard.press('Enter');await expect(page.locator('main')).toBeFocused();
 expect(errors).toEqual([]);record(`${info.project.name}-screens`,{tested_at:new Date().toISOString(),screens:audit,page_errors:errors});
});
