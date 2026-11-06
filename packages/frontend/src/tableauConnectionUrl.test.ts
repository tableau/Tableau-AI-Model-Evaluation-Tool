import { describe, expect, it } from 'bun:test';
import { parseTableauConnectionUrl } from './tableauConnectionUrl';

describe('parseTableauConnectionUrl', () => {
  it('extracts the server and case-sensitive site from a Tableau browser link', () => {
    expect(parseTableauConnectionUrl('https://tableau.example.com/#/site/Evaluation/views/SampleWorkbook/SampleDashboard'))
      .toEqual({ server_url: 'https://tableau.example.com', site: 'Evaluation' });
  });

  it('preserves the port and decodes the site without query parameters', () => {
    expect(parseTableauConnectionUrl('  http://tableau.example:8080/#/site/Eval%20Testing/views/Book/View?:showVizHome=no  '))
      .toEqual({ server_url: 'http://tableau.example:8080', site: 'Eval Testing' });
  });

  it('handles direct view links with a site path', () => {
    expect(parseTableauConnectionUrl('https://tableau.example/t/Eval-Testing/views/Book/View'))
      .toEqual({ server_url: 'https://tableau.example', site: 'Eval-Testing' });
  });

  it('clears the site for default-site content links', () => {
    for (const path of ['/#/views/Book/View', '/views/Book/View?:showVizHome=no', '/#/home']) {
      expect(parseTableauConnectionUrl(`https://tableau.example${path}`))
        .toEqual({ server_url: 'https://tableau.example', site: '' });
    }
  });

  it('leaves the site unchanged for a bare server URL', () => {
    expect(parseTableauConnectionUrl('https://tableau.example/'))
      .toEqual({ server_url: 'https://tableau.example' });
  });

  it('leaves invalid, non-HTTP and credential-bearing pastes alone', () => {
    for (const text of ['not a URL', 'ftp://tableau.example', 'https://user:secret@tableau.example', 'https://tableau.example/#/site/%ZZ/views/Book/View']) {
      expect(parseTableauConnectionUrl(text)).toBeNull();
    }
  });
});
