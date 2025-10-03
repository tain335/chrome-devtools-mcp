import assert from 'node:assert';
import {describe, it} from 'node:test';

import {takeElementSnapshot} from '../../src/tools/element_snapshot.js';
import {withBrowser} from '../utils.js';

describe('take_element_snapshot', () => {
  describe('browser_element_snapshot', () => {
    it('should take a snapshot of the page', async () => {
      await withBrowser(async (response, context) => {
        await takeElementSnapshot.handler({params: {format: 'png'}}, response, context);
        const res = response.format("take_element_snapshot", context);
        assert.ok(Boolean(res.find((e)=> e.mimeType === 'image/png')));
      }, {debug: true, url: 'https://www.google.com/'});
    });
    it('should get element by uid', async () => {
      await withBrowser(async (response, context) => {
        await takeElementSnapshot.handler({params: {format: 'png'}}, response, context);
        // @ts-expect-error getElementSnapshot is not typed
        assert.ok(Boolean(context.getElementSnapshot()?.elementResults.length > 0));
     
        assert.ok(Boolean(await context.getElementByUid('#1_1')));
      }, {debug: true, url: 'https://www.google.com/'});
    });
  });
});