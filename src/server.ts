/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as express from 'express';
import * as fs from 'fs';
import * as morgan from 'morgan';
import * as url from 'url';

import * as datastore from './lib/datastore';

import cookieSession = require('cookie-session');
import * as github from './lib/github';
import {config} from './lib/config';
import {totpCode} from './lib/totp-code';
import * as request from 'request';
import {require2fa} from './lib/packument';
import uuid = require('uuid');
import * as path from 'path';
import {json} from './lib/json';
import {drainRequest} from './lib/drain-request';

const validatePackage = require('validate-npm-package-name');

import {publish} from './routes/publish';
import {putDeleteTag} from './routes/put-delete-tag';

const ONE_DAY = 1000 * 60 * 60 * 24;
const unsafe = require('./lib/unsafe.js');
const app = express();

const readStatic = (p: string) => {
  return fs.readFileSync(path.resolve(__dirname + '/../../html', p));
};

const ghcss =
    fs.readFileSync(require.resolve('github-markdown-css/github-markdown.css'));
const favicon = readStatic('favicon.ico');
const changelog = readStatic('changelog.html')
                      .toString('utf8')
                      // Reduce the heading level in the CHANGELOG by 1:
                      .replace(/h3/g, 'h4')
                      .replace(/h2/g, 'h3')
                      .replace(/h1/g, 'h2');
const documentation =
    readStatic('documentation.html')
        .toString('utf8')
        .replace(
            '{registry-href}',
            config.userRegistryUrl || 'http://127.0.0.1:8080');
const appjs = readStatic('app.js');
const css = readStatic('app.css');
const loginPage = readStatic('login.html') + '';
const tokenSettingsPage = readStatic('token-settings.html') + '';
const manageTokensPage = readStatic('manage-tokens.html') + '';

const SUFFIX_STRING = '_ns';

let indexHtml = readStatic('index.html') + '';
// add documentation from rendered markdown:
indexHtml = indexHtml.replace('{documentation}', documentation)
                .replace('{changelog}', changelog);

const uuidregex =
    /[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;
morgan.token(
    'cleanurl',
    (req: express.Request) => req.url.replace(uuidregex, '<token>'));

app.use(morgan(
    ':remote-addr :remote-user :method :cleanurl HTTP/:http-version :status :res[content-length] - :response-time ms',
    {stream: process.stdout}));


app.use((req, res, next) => {
  // handle namespaces
  const matches = req.url.match(/^(.+)(\/_ns\/|\/_ns$)/);
  if (matches) {
    req.npmrcNamespace = matches[1];
    req.url = req.url.substr(matches[0].length);
    if (!req.url.length) {
      req.url = '/';
    } else {
      req.url = '/' + req.url;
    }
  }

  // handle package urls. assume that if write=true is sent its a metadata
  // request /package?write=true
  if (req.query.write === 'true') {
    // this is a package metadata request
    req.url = '/_/metadata' + req.url;
  }
  next();
});

const serve = (p: string, data: string|Buffer, loginServer?: boolean) => {
  app.get(p, (req, res) => {
    if (loginServer && !config.loginEnabled) {
      res.statusCode = 401;
      return res.end();
    }
    res.end(data);
  });
};

serve('/favicon.ico', favicon);
serve('/app.js', appjs);
serve('/github-markdown.css', ghcss);
serve('/app.css', css);

// whoami
app.get('/-/whoami', wrap(async (req, res) => {
          const auth = req.headers['authorization'] + '';
          const token = auth.split(' ').pop();
          const pubKey = await datastore.getPublishKey(token + '');

          if (pubKey) {
            return res.end(`{"username":"github_user:${pubKey.username}"}`);
          }

          res.end('{}');
        }));

app.post('/_/2fa', wrap(async (req, res) => {
           const packageName = req.query.packageName || '';
           let result: {status: number, data: Buffer}|undefined;
           try {
             result = await require2fa(
                 packageName, config.npmToken, totpCode(config.totpSecret));
           } catch (e) {
             return res.end(
                 '{"error":"server error setting required 2fa on package"}');
           }
           console.log(result.data + '');

           res.statusCode = result ? result.status : 500;
           if (res.statusCode === 200) {
             res.end('"ok"');
           } else {
             res.end('oh no');
           }
         }));

app.post('/-/package/:package/access', (req, res) => {
  console.log('hit');
  res.end('not supported');
});

app.post(
    '/-/v1/login', wrap(async (req, res) => {
      // serve a new token to the npm cli.
      // If they've provided an npmrcNamespace add it to the loginUrl as a
      // package name hint
      const packageNameHint = req.npmrcNamespace ?
          '&package=' + encodeURIComponent(req.npmrcNamespace.substr(1)) :
          '';
      const token =
          await datastore.saveHandoffKey(datastore.generatePublishKey());
      res.end(`{"doneUrl":"${config.userRegistryUrl}/_/done?ott=${
          token}","loginUrl":"${config.userLoginUrl}/_/token-settings?ott=${
          token}${packageNameHint}"}`);
    }));

app.get('/_/done', wrap(async (req, res) => {
          const parsed = url.parse(req.url, true);
          const query = parsed.query || {};

          const handoff = await datastore.getHandoffKey(query.ott + '');
          if (!handoff) {
            // to prevent the cli form falling back to couchdb auth we send a
            // 200 but no token. this leaves quite a bit to be desired as far as
            // messaging in the cli but prevents falling back to an interactive
            // login.
            res.status(200);
            res.header(
                'npm-notice', 'The one time token expired or is invalid.');
            res.end('{"token":""}');
          } else if (!handoff.complete) {
            res.header('retry-after', '3');
            res.status(202);
            res.end('{}');
          } else if (handoff.complete) {
            res.end(JSON.stringify({token: handoff.value}));
          }
        }));


// so you can fetch package documents from wombot if '?write=true' is in the
// query string. required for npm deprecate.
app.get('/_/metadata/:package', (req, res) => {
  console.log(
      'proxying write metadata request to npm for ', req.params.package);
  request('https://registry.npmjs.org/' + req.params.package).pipe(res);
});
// now just proxy anything thats a valid single chunk
app.get(/^\/[^/]+$/, (req, res, next) => {
  const pkg = decodeURIComponent(req.url.substr(1));
  console.log('proxying metadata request to npm for ', pkg);
  if (validatePackage(pkg).validForOldPackages) {
    request('https://registry.npmjs.org/' + req.url).pipe(res);
    return;
  }
  next();
});

// serve dist-tag list
app.get('/-/package/:package/dist-tags', (req, res) => {
  request('https://registry.npmjs.org' + req.url).pipe(res);
});


// web --------------------------------
app.use(cookieSession({
  name: 'session',
  keys: [config.sessionSecret || 'wombats are fun'],
}));

const redirectToLoginServer = (req: express.Request, res: express.Response) => {
  if (!config.loginEnabled) {
    if (req.query.redir) {
      res.end('login disabled and there is maybe a redirect loop.');
    } else if (config.userLoginUrl) {
      res.redirect(config.userLoginUrl + req.url);
    } else {
      res.end('these are not the droids you\'re looking for');
    }
    return true;
  }
  return false;
};


app.get('/', wrap(async (req, res) => {
          if (redirectToLoginServer(req, res)) {
            return;
          }

          res.header('Content-type', 'text/html');

          if (req.session!.token) {
            let page = indexHtml + '';
            page = page.replace('{username}', req.session!.user.login);
            res.end(page);

          } else {
            const {link, code} =
                github.webAccessLink(config.githubId, config.githubSecret, []);
            const page = loginPage.replace('{link}', link);
            res.end(page);
          }
        }));

app.post('/logout', (req, res) => {
  unsafe.clearSession(req);
  res.end('"ok"');
});

// gh-auth receive callback
app.get(
    '/oauth/github', wrap(async (req, res) => {
      // https://github.com/login/oauth/access_token
      if (!config.loginEnabled) {
        res.end('service disabled.');
      }

      if (!req.query || !req.query.code) {
        res.status(403);
        res.send('error processing login. <a href="/">try again</a>.');
        return;
      }

      try {
        const token = await github.webAccessToken(
            config.githubId, config.githubSecret, req.query.code);

        const query = req.session!.query;
        delete req.session!.query;
        const user = await github.getUser(token);

        await datastore.createUser(user.login, token);

        if (query && query.token) {
          delete query.token;
          query.keyCreated = 1;

          await datastore.savePublishKey(user.login, query.token);
        }

        req.session!.user = unsafe.ghUserData(user) as {[k: string]: string};
        req.session!.token = token;

        // resume adding a key =)
        if (req.session!.loginRedirect) {
          return res.redirect(req.session!.loginRedirect);
        }
        res.redirect('/');
      } catch (e) {
        res.status(401);
        // TODO: stop showing real error.
        console.log('error logging in ' + e);
        res.send('error logging in. <br/><a href="/">please try again</a> ');
      }
    }));

app.get('/_/done', wrap(async (req, res) => {
          const parsed = url.parse(req.url, true);
          const query = parsed.query || {};

          const handoff = await datastore.getHandoffKey(query.ott + '');
          if (!handoff) {
            res.statusCode = 404;
            return res.end();
          }

          return;
        }));

app.get(
    '/_/token', wrap(async (req, res) => {
      if (redirectToLoginServer(req, res)) {
        return;
      }

      // TODO handle
      if (!req.session!.token) {
        req.session!.loginRedirect = req.url;
        // not logged in.
        return res.redirect('/');
      }

      let ttl = undefined;
      let releaseAs2FA = undefined;
      if (req.query.type === 'ttl') {
        ttl = Date.now() + ONE_DAY;
      } else if (req.query.type === 'release') {
        releaseAs2FA = true;
      } else if (!req.query.package || !req.query.package.trim().length) {
        res.statusCode = 400;
        return res.end('"package name required."');
      }

      const handoff = await datastore.getHandoffKey(req.query.ott + '');

      if (handoff) {
        await Promise.all([
          datastore.savePublishKey(
              req.session!.user.login, handoff.value,
              req.query.package ? (req.query.package + '').trim() : undefined,
              ttl, releaseAs2FA),
          datastore.completeHandoffKey(req.query.ott + '')
        ]);
        res.header('content-type', 'text/html');
        res.end(
            '<p>Token created!</p><p>You may close this window, or <a href="/">click here</a> to manage your tokens.</p>');
      } else {
        res.statusCode = 404;
        res.end('failed to login. run npm login again.');
      }
    }));

app.get('/_/token-settings', wrap(async (req, res) => {
          if (redirectToLoginServer(req, res)) {
            return;
          }

          res.header('content-type', 'text/html');
          res.header('x-frame-options', 'deny');
          res.end(tokenSettingsPage);
        }));

app.get('/_/manage-tokens', wrap(async (req, res) => {
          if (redirectToLoginServer(req, res)) {
            return;
          }

          // redirect to index is not logged in. connect with github flow works
          // there.
          if (!req.session!.token) {
            res.statusCode = 302;
            res.header('location', '/');
            res.end();
            return;
          }

          let page = manageTokensPage + '';
          page = page.replace('{username}', req.session!.user.login);

          res.header('x-frame-options', 'deny');
          res.header('content-type', 'text/html');
          res.end(page);
        }));

app.get('/_/api/v1/tokens', (req, res) => {
  if (redirectToLoginServer(req, res)) {
    return;
  }

  datastore.getPublishKeys(req.session!.user.login)
      .then((keys) => {
        // CANNOT SEND REAL KEY TO THE FRONTEND.
        const cleaned: Array<{
          created: number,
          prefix: string,
          package?: string,
          expiration?: number,
          'release-backed'?: boolean
        }> = [];
        keys.forEach((row) => {
          cleaned.push({
            created: row.created,
            prefix: row.value.substr(0, 5),
            package: row.package,
            expiration: row.expiration,
            'release-backed': row.releaseAs2FA
          });
        });

        res.end(JSON.stringify({error: false, data: cleaned}));
      })
      .catch((e) => {
        const code = uuid.v4();
        console.log(
            'error loading user tokens list ' + req.session!.user.login +
            ' error:\n' + e);
        res.end(JSON.stringify({
          error: 'error loading tokens. contact support with code ' + code
        }));
      });
});

app.delete('/_/api/v1/token', async (req, res) => {
  if (redirectToLoginServer(req, res)) {
    return;
  }

  if (avoidCSRF(req, res)) {
    return;
  }

  const result = await drainRequest(req) + '';
  const body = json(result);

  if (!body) {
    return res.end(JSON.stringify({error: 'malformed json request body'}));
  }

  const prefix = body.prefix || '';
  const created = (body.created || 0);

  if (!prefix || !created) {
    return res.end(JSON.stringify(
        {error: 'missing token prefix or created in json request body'}));
  }

  datastore.getObfuscatedPublishKey(req.session!.user.login, created, prefix)
      .then(async (key) => {
        let error;
        if (key) {
          await datastore.deletePublishKey(key.value);
        } else {
          error = 'couldn\'t find key';
        }

        res.end(JSON.stringify({error, data: !!key}));
      })
      .catch((e) => {
        const code = uuid.v4();
        console.log(
            'error deleting token ' + req.session!.user.login + ' error:\n' +
            e);
        res.end(JSON.stringify({
          error: 'error loading tokens. contact support with code ' + code
        }));
      });
});

app.put('/_/api/v1/token', async (req, res) => {
  if (redirectToLoginServer(req, res)) {
    return;
  }

  if (avoidCSRF(req, res)) {
    return;
  }

  const result = await drainRequest(req) + '';
  const body = json(result);

  if (!body) {
    return res.end(JSON.stringify({error: 'malformed json request body'}));
  }

  const packageName = body.package;

  if (!packageName || !(packageName + '').trim().length) {
    return res.end(
        JSON.stringify({error: 'missing package key in request body'}));
  }

  console.log(
      'AUDIT', new Date().toJSON(), 'user', req.session!.user.login,
      'creating publish token for', packageName);


  const packages = packageName.split('\n');
  const saves = packages.map((name: string) => {
    const key = uuid.v4();
    const saveResult =
        datastore.savePublishKey(req.session!.user.login, key, name + '');
    return saveResult.then(() => {
      return {token: key, package: name};
    });
  });

  try {
    const result = await Promise.all(saves);
    console.log('api create token. save result.', result);
    res.end(JSON.stringify({data: result}));
  } catch (e) {
    const id = uuid.v4();
    console.log('ERROR saing new keys : id:' + id, e + '');
    res.end(JSON.stringify({error: 'error saving new keys. id ' + id}));
  }
});

type Handler = (req: express.Request, res: express.Response) =>
    Promise<void>|void;

function wrap(a: Handler) {
  return (req: express.Request, res: express.Response) => {
    const p = a(req, res);
    if (p) {
      p.catch((e) => {
        const id = uuid.v4().replace(/[-]+/g, '');
        console.error(
            'unhandled request handler rejection. ' + id + ' ' +
            JSON.stringify(e + e.stack));
        res.status(500);
        res.end('server error ping support with id: ' + id);
      });
    }
  };
}

function avoidCSRF(req: express.Request, res: express.Response) {
  const origin = req.headers.referer || req.headers.origin;
  // light CSRF check.
  if (origin && origin.indexOf(process.env.LOGIN_URL || '') !== 0) {
    const logid = uuid.v4();
    console.log('token service csrf error ' + logid, req.headers);
    res.statusCode = 400;
    res.end(JSON.stringify({
      'error':
          'please refresh the page and try your request again. support id: ' +
          logid
    }));
    return true;
  }
  return false;
}

app.put(/^\/[^\/]+$/, wrap(publish));
app.put('/-/package/:package/dist-tags/:tag', wrap(putDeleteTag));
app.delete('/-/package/:package/dist-tags/:tag', wrap(putDeleteTag));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
