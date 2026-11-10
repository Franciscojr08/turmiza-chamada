/*
 * Leitura do quadro de respostas do caderno do Turmiza numa foto (OMR), feita no próprio celular: a foto não sai do
 * aparelho, só as letras lidas vão ao Apps Script.
 *
 * O quadro é desenhado pelo App\Support\CadernoLayout (PHP), em milímetros a partir do canto superior esquerdo. A
 * função layoutCaderno() abaixo faz a mesma conta; os dois lados são conferidos pelos testes (CadernoRespostasTest e
 * tests/js/correcao-omr.test.js). Mudou a geometria: mude os dois e suba a VERSAO, que vai no QR.
 *
 * Passos: tons de cinza, binarização adaptativa (aguenta sombra), componentes conexos, as quatro marcas pretas dos
 * cantos (quadrados cheios), homografia milímetro → pixel e, em cada bolinha, a média do escuro no miolo, comparada
 * ao preto das marcas e ao branco do papel.
 *
 * Funciona no navegador (window.TurmizaOmr) e no Node (module.exports), para os testes.
 */
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) {
        module.exports = fabrica();
    } else {
        raiz.TurmizaOmr = fabrica();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VERSAO = 1;
    var L = {
        LARGURA: 180, MARCA: 6, MARGEM_MARCA: 3, ESQUERDA: 12, LARGURA_GRADE: 156, TOPO_GRADE: 32,
        CABECALHO_LETRAS: 5, RODAPE: 8, ROTULO: 9, QR_X: 140, QR_Y: 4, QR_TAMANHO: 25, MAX_LINHAS: 25,
    };

    /** Limiares da leitura, na escala 0 (papel) a 1 (preto da marca). */
    var MARCADA = 0.45;
    var DUVIDA = 0.18;

    function mm(valor) {
        return Math.round(valor * 100) / 100;
    }

    /** A mesma conta do App\Support\CadernoLayout::para(). */
    function layoutCaderno(questoes, alternativas) {
        questoes = Math.max(1, questoes);
        alternativas = alternativas === 4 ? 4 : 5;
        var letras = 'ABCDE'.slice(0, alternativas).split('');
        var colunas = questoes <= 5 ? 1 : Math.max(2, Math.ceil(questoes / L.MAX_LINHAS));
        var linhas = Math.ceil(questoes / colunas);
        var passoY = linhas <= 15 ? 7.0 : (linhas <= 20 ? 6.2 : 5.1);
        var larguraColuna = L.LARGURA_GRADE / colunas;
        var passoX = Math.min(8.0, (larguraColuna - L.ROTULO) / alternativas);
        var diametro = Math.min(5.2, passoX * 0.8, passoY * 0.82);
        var conteudo = L.ROTULO + alternativas * passoX;
        var altura = L.TOPO_GRADE + L.CABECALHO_LETRAS + linhas * passoY + L.RODAPE;
        var centro = L.MARGEM_MARCA + L.MARCA / 2;
        var lista = [];

        for (var coluna = 0; coluna < colunas; coluna++) {
            var inicio = L.ESQUERDA + coluna * larguraColuna + (larguraColuna - conteudo) / 2;

            for (var linha = 0; linha < linhas; linha++) {
                var indice = coluna * linhas + linha;

                if (indice >= questoes) {
                    break;
                }

                var y = mm(L.TOPO_GRADE + L.CABECALHO_LETRAS + passoY * (linha + 0.5));
                var bolhas = letras.map(function (letra, k) {
                    return { letra: letra, x: mm(inicio + L.ROTULO + passoX * (k + 0.5)), y: y };
                });

                lista.push({ indice: indice, x: mm(inicio), y: y, bolhas: bolhas });
            }
        }

        lista.sort(function (a, b) { return a.indice - b.indice; });

        return {
            colunas: colunas,
            linhas: linhas,
            altura: mm(altura),
            diametro: mm(diametro),
            passoX: mm(passoX),
            passoY: mm(passoY),
            marcas: [
                { x: centro, y: centro },
                { x: L.LARGURA - centro, y: centro },
                { x: centro, y: mm(altura - centro) },
                { x: L.LARGURA - centro, y: mm(altura - centro) },
            ],
            questoes: lista,
            qr: { x: L.QR_X, y: L.QR_Y, tamanho: L.QR_TAMANHO },
        };
    }

    /**
     * O código do caderno, de um link do QR (…#c=1.12.34.10.5.abcdef012345) ou do código puro.
     * Devolve null se não for de um caderno desta versão.
     */
    function lerToken(texto) {
        var bruto = String(texto || '');
        var achado = /(?:^|[#&?]c=)(\d{1,3}\.\d{1,10}\.\d{1,10}\.\d{1,3}\.[45]\.[a-f0-9]{12})(?:$|&)/.exec(bruto);

        if (!achado) {
            return null;
        }

        var partes = achado[1].split('.');

        if (parseInt(partes[0], 10) !== VERSAO) {
            return null;
        }

        return {
            token: achado[1],
            avaliacao: parseInt(partes[1], 10),
            matricula: parseInt(partes[2], 10),
            questoes: parseInt(partes[3], 10),
            alternativas: parseInt(partes[4], 10),
            assinatura: partes[5],
        };
    }

    function paraCinza(rgba, largura, altura) {
        var cinza = new Uint8ClampedArray(largura * altura);

        for (var i = 0, j = 0; i < cinza.length; i++, j += 4) {
            cinza[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
        }

        return cinza;
    }

    /** Binarização de Bradley: escuro é o que fica 15% abaixo da média da vizinhança. */
    function binarizar(cinza, largura, altura) {
        var lado = Math.max(15, Math.round(Math.min(largura, altura) / 12)) | 1;
        var metade = lado >> 1;
        var integral = new Float64Array((largura + 1) * (altura + 1));
        var saida = new Uint8Array(largura * altura);
        var x, y;

        for (y = 0; y < altura; y++) {
            var soma = 0;

            for (x = 0; x < largura; x++) {
                soma += cinza[y * largura + x];
                integral[(y + 1) * (largura + 1) + x + 1] = integral[y * (largura + 1) + x + 1] + soma;
            }
        }

        for (y = 0; y < altura; y++) {
            var y1 = Math.max(0, y - metade);
            var y2 = Math.min(altura - 1, y + metade);

            for (x = 0; x < largura; x++) {
                var x1 = Math.max(0, x - metade);
                var x2 = Math.min(largura - 1, x + metade);
                var area = (x2 - x1 + 1) * (y2 - y1 + 1);
                var total = integral[(y2 + 1) * (largura + 1) + x2 + 1] - integral[y1 * (largura + 1) + x2 + 1]
                    - integral[(y2 + 1) * (largura + 1) + x1] + integral[y1 * (largura + 1) + x1];

                saida[y * largura + x] = cinza[y * largura + x] * area < total * 0.85 ? 1 : 0;
            }
        }

        return saida;
    }

    /** Componentes conexos (vizinhança de 4) dos pixels escuros, com área, caixa e centro. */
    function componentes(binario, largura, altura) {
        var rotulos = new Int32Array(largura * altura);
        var pilha = new Int32Array(largura * altura);
        var lista = [];
        var proximo = 1;

        for (var inicio = 0; inicio < binario.length; inicio++) {
            if (!binario[inicio] || rotulos[inicio]) {
                continue;
            }

            var topo = 0;
            var item = { area: 0, minX: largura, maxX: 0, minY: altura, maxY: 0, sx: 0, sy: 0 };
            pilha[topo++] = inicio;
            rotulos[inicio] = proximo;

            while (topo > 0) {
                var p = pilha[--topo];
                var px = p % largura;
                var py = (p - px) / largura;
                item.area++;
                item.sx += px;
                item.sy += py;
                if (px < item.minX) { item.minX = px; }
                if (px > item.maxX) { item.maxX = px; }
                if (py < item.minY) { item.minY = py; }
                if (py > item.maxY) { item.maxY = py; }

                if (px > 0 && binario[p - 1] && !rotulos[p - 1]) { rotulos[p - 1] = proximo; pilha[topo++] = p - 1; }
                if (px < largura - 1 && binario[p + 1] && !rotulos[p + 1]) { rotulos[p + 1] = proximo; pilha[topo++] = p + 1; }
                if (py > 0 && binario[p - largura] && !rotulos[p - largura]) { rotulos[p - largura] = proximo; pilha[topo++] = p - largura; }
                if (py < altura - 1 && binario[p + largura] && !rotulos[p + largura]) { rotulos[p + largura] = proximo; pilha[topo++] = p + largura; }
            }

            proximo++;

            if (item.area >= 12) {
                item.cx = item.sx / item.area;
                item.cy = item.sy / item.area;
                lista.push(item);
            }
        }

        return lista;
    }

    /** Quadrados cheios: proporção perto de 1 e quase toda a caixa escura (bolinha cheia fica perto de 0,78). */
    function candidatosMarca(lista, largura, altura) {
        var menor = Math.min(largura, altura);

        return lista.filter(function (c) {
            var w = c.maxX - c.minX + 1;
            var h = c.maxY - c.minY + 1;
            var lado = Math.max(w, h);

            return w / h > 0.6 && w / h < 1.65 && c.area / (w * h) >= 0.8 && lado >= menor * 0.008 && lado <= menor * 0.2;
        });
    }

    function distancia(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    /**
     * As quatro marcas, na ordem do quadro: superior esquerda, superior direita, inferior esquerda, inferior direita.
     * Com o QR, só valem quadrados do tamanho esperado (a marca tem 6 mm e o QR uns 22 mm) e o QR fica perto da marca
     * superior direita, o que resolve a foto girada.
     */
    function escolherMarcas(candidatos, qr, layout) {
        var lista = candidatos;

        if (qr && qr.cantos && qr.cantos.length === 4) {
            var previstas = preverPeloQr(candidatos, qr, layout);

            if (previstas) {
                return previstas;
            }
        }

        if (qr) {
            var ladoQr = (distancia(qr.cantos[0], qr.cantos[1]) + distancia(qr.cantos[1], qr.cantos[2])) / 2;
            var esperado = ladoQr * 6 / 22.5;
            lista = lista.filter(function (c) {
                var lado = Math.sqrt(c.area);

                return lado > esperado * 0.5 && lado < esperado * 1.7;
            });
        } else if (lista.length > 4) {
            var maior = Math.max.apply(null, lista.map(function (c) { return c.area; }));
            lista = lista.filter(function (c) { return c.area >= maior * 0.35; });
        }

        if (lista.length < 4) {
            return null;
        }

        var pontos = lista.map(function (c) { return { x: c.cx, y: c.cy, c: c }; });
        var extremo = function (fn) {
            return pontos.reduce(function (melhor, p) { return fn(p) > fn(melhor) ? p : melhor; });
        };
        // Cantos da imagem, no sentido horário a partir do superior esquerdo.
        var cantos = [
            extremo(function (p) { return -p.x - p.y; }),
            extremo(function (p) { return p.x - p.y; }),
            extremo(function (p) { return p.x + p.y; }),
            extremo(function (p) { return -p.x + p.y; }),
        ];

        if (new Set(cantos).size !== 4) {
            return null;
        }

        // Qual canto da imagem é o superior direito do quadro: o mais perto do QR; sem QR, o quadro é mais largo que alto.
        var giro = 1;

        if (qr) {
            var centroQr = qr.cantos.reduce(function (s, p) { return { x: s.x + p.x / 4, y: s.y + p.y / 4 }; }, { x: 0, y: 0 });
            var perto = cantos.map(function (p) { return distancia(p, centroQr); });
            giro = perto.indexOf(Math.min.apply(null, perto));
        } else if (distancia(cantos[0], cantos[1]) < distancia(cantos[1], cantos[2])) {
            giro = 2;
        }

        // giro = posição (no sentido horário) do superior direito do quadro; o superior esquerdo vem antes dele.
        var se = cantos[(giro + 3) % 4];
        var sd = cantos[giro];
        var id = cantos[(giro + 1) % 4];
        var ie = cantos[(giro + 2) % 4];

        return [se, sd, ie, id];
    }

    /**
     * O QR é impresso em pé num lugar conhecido do quadro: os 4 cantos dele (na ordem do próprio QR, como o jsQR
     * devolve) dão uma primeira homografia, que prevê onde cada marca está. Para cada previsão vale o quadrado do
     * tamanho certo mais perto dela, o que deixa de fora logotipos e outros quadrados escuros da folha.
     */
    function preverPeloQr(candidatos, qr, layout) {
        var modulos = qr.modulos || 41;
        var zona = L.QR_TAMANHO * 2 / (modulos + 4);
        var x0 = L.QR_X + zona, y0 = L.QR_Y + zona, x1 = L.QR_X + L.QR_TAMANHO - zona, y1 = L.QR_Y + L.QR_TAMANHO - zona;
        var hq = homografia([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], qr.cantos);

        if (!hq) {
            return null;
        }

        var escala = (distancia(qr.cantos[0], qr.cantos[1]) + distancia(qr.cantos[1], qr.cantos[2])) / 2 / (x1 - x0);
        var centroQr = { x: L.QR_X + L.QR_TAMANHO / 2, y: L.QR_Y + L.QR_TAMANHO / 2 };
        var usadas = [];
        var achadas = [];

        for (var i = 0; i < 4; i++) {
            var m = layout.marcas[i];
            var previsto = aplicar(hq, m.x, m.y);
            var tolerancia = Math.max(15, 0.3 * distancia(m, centroQr)) * escala;
            var melhor = null;
            var menor = Infinity;

            candidatos.forEach(function (c) {
                var lado = Math.sqrt(c.area) / escala;
                var d = Math.hypot(c.cx - previsto.x, c.cy - previsto.y);

                if (lado > L.MARCA * 0.5 && lado < L.MARCA * 1.7 && d < tolerancia && d < menor && usadas.indexOf(c) === -1) {
                    melhor = c;
                    menor = d;
                }
            });

            if (!melhor) {
                return null;
            }

            usadas.push(melhor);
            achadas.push({ x: melhor.cx, y: melhor.cy, c: melhor });
        }

        return achadas;
    }

    /** Homografia que leva os 4 pontos de origem aos 4 de destino (h33 = 1). */
    function homografia(origem, destino) {
        var a = [];
        var b = [];

        for (var i = 0; i < 4; i++) {
            var x = origem[i].x, y = origem[i].y, u = destino[i].x, v = destino[i].y;
            a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
            b.push(u);
            a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
            b.push(v);
        }

        for (var col = 0; col < 8; col++) {
            var pivo = col;

            for (var lin = col + 1; lin < 8; lin++) {
                if (Math.abs(a[lin][col]) > Math.abs(a[pivo][col])) { pivo = lin; }
            }

            if (Math.abs(a[pivo][col]) < 1e-12) {
                return null;
            }

            var t = a[col]; a[col] = a[pivo]; a[pivo] = t;
            var tb = b[col]; b[col] = b[pivo]; b[pivo] = tb;

            for (lin = 0; lin < 8; lin++) {
                if (lin === col) { continue; }
                var f = a[lin][col] / a[col][col];
                for (var k = col; k < 8; k++) { a[lin][k] -= f * a[col][k]; }
                b[lin] -= f * b[col];
            }
        }

        var h = b.map(function (valor, i) { return valor / a[i][i]; });
        h.push(1);

        return h;
    }

    function aplicar(h, x, y) {
        var w = h[6] * x + h[7] * y + h[8];

        return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
    }

    function amostra(cinza, largura, altura, x, y) {
        var x0 = Math.floor(x), y0 = Math.floor(y);

        if (x0 < 0 || y0 < 0 || x0 >= largura - 1 || y0 >= altura - 1) {
            return 255;
        }

        var fx = x - x0, fy = y - y0, i = y0 * largura + x0;

        return cinza[i] * (1 - fx) * (1 - fy) + cinza[i + 1] * fx * (1 - fy) + cinza[i + largura] * (1 - fx) * fy + cinza[i + largura + 1] * fx * fy;
    }

    /** Média do cinza num disco (em mm) em volta do centro, levado à foto pela homografia. */
    function mediaDisco(imagem, h, cx, cy, raio) {
        var soma = 0, n = 0;

        for (var anel = 0; anel <= 3; anel++) {
            var r = raio * anel / 3;
            var passos = anel === 0 ? 1 : 8 * anel;

            for (var k = 0; k < passos; k++) {
                var ang = 2 * Math.PI * k / passos;
                var p = aplicar(h, cx + r * Math.cos(ang), cy + r * Math.sin(ang));
                soma += amostra(imagem.cinza, imagem.largura, imagem.altura, p.x, p.y);
                n++;
            }
        }

        return soma / n;
    }

    /** Média do mais escuro de cada raio no contorno das bolinhas (vários raios, para não passar entre a linha). */
    function mediaContornos(imagem, h, layout) {
        var soma = 0, n = 0;

        layout.questoes.forEach(function (q) {
            q.bolhas.forEach(function (b) {
                for (var k = 0; k < 12; k++) {
                    var ang = 2 * Math.PI * k / 12;
                    var menor = 255;

                    [0.4, 0.45, 0.5, 0.55, 0.6].forEach(function (f) {
                        var p = aplicar(h, b.x + f * layout.diametro * Math.cos(ang), b.y + f * layout.diametro * Math.sin(ang));
                        menor = Math.min(menor, amostra(imagem.cinza, imagem.largura, imagem.altura, p.x, p.y));
                    });

                    soma += menor;
                    n++;
                }
            });
        });

        return soma / n;
    }

    function percentil(valores, fracao) {
        var ordenados = valores.slice().sort(function (a, b) { return a - b; });

        return ordenados[Math.min(ordenados.length - 1, Math.floor(fracao * ordenados.length))];
    }

    /**
     * Lê o quadro. `imagem` = { cinza, largura, altura }; `opcoes` = { questoes, alternativas, qr: { cantos: [4 pontos] } }.
     * Devolve { ok, respostas (uma letra, '-' em branco ou '*' dupla, por questão), duvidas (índices), bolhas, marcas }
     * ou { ok: false, motivo }.
     */
    function lerCaderno(imagem, opcoes) {
        var layout = layoutCaderno(opcoes.questoes, opcoes.alternativas);
        var binario = binarizar(imagem.cinza, imagem.largura, imagem.altura);
        var marcas = escolherMarcas(candidatosMarca(componentes(binario, imagem.largura, imagem.altura), imagem.largura, imagem.altura), opcoes.qr || null, layout);

        if (!marcas) {
            return { ok: false, motivo: 'marcas' };
        }

        var largura = (distancia(marcas[0], marcas[1]) + distancia(marcas[2], marcas[3])) / 2;
        var alturaFoto = (distancia(marcas[0], marcas[2]) + distancia(marcas[1], marcas[3])) / 2;
        var esperada = (L.LARGURA - L.MARCA - 2 * L.MARGEM_MARCA) / (layout.altura - L.MARCA - 2 * L.MARGEM_MARCA);

        if (alturaFoto < 1 || Math.abs(largura / alturaFoto / esperada - 1) > 0.45) {
            return { ok: false, motivo: 'marcas' };
        }

        var h = homografia(layout.marcas, marcas);

        if (!h) {
            return { ok: false, motivo: 'marcas' };
        }

        var preto = layout.marcas.reduce(function (s, m) { return s + mediaDisco(imagem, h, m.x, m.y, L.MARCA * 0.3); }, 0) / 4;
        var raio = layout.diametro * 0.32;
        var valores = layout.questoes.map(function (q) {
            return q.bolhas.map(function (b) { return mediaDisco(imagem, h, b.x, b.y, raio); });
        });
        var todos = [].concat.apply([], valores);
        var branco = percentil(todos, 0.9);

        if (branco - preto < 40) {
            return { ok: false, motivo: 'contraste' };
        }

        // Confere o encaixe: o contorno impresso das bolinhas tem que estar onde a conta diz. Com marcas erradas (um
        // quadrado de fora, um canto cortado), as amostras caem no papel e a leitura é recusada.
        if ((branco - mediaContornos(imagem, h, layout)) / (branco - preto) < 0.25) {
            return { ok: false, motivo: 'marcas' };
        }

        var respostas = '';
        var duvidas = [];
        var bolhas = [];

        valores.forEach(function (linha, i) {
            var escuros = linha.map(function (v) { return Math.max(0, Math.min(1, (branco - v) / (branco - preto))); });
            var marcadas = [];
            var incerta = false;

            escuros.forEach(function (d, k) {
                if (d >= MARCADA) { marcadas.push(k); } else if (d >= DUVIDA) { incerta = true; }
                var centro = aplicar(h, layout.questoes[i].bolhas[k].x, layout.questoes[i].bolhas[k].y);
                bolhas.push({ questao: i, letra: layout.questoes[i].bolhas[k].letra, x: centro.x, y: centro.y, escuro: d });
            });

            if (marcadas.length > 1) {
                respostas += '*';
            } else if (marcadas.length === 1) {
                respostas += layout.questoes[i].bolhas[marcadas[0]].letra;
            } else {
                var maior = escuros.indexOf(Math.max.apply(null, escuros));
                respostas += escuros[maior] >= DUVIDA ? layout.questoes[i].bolhas[maior].letra : '-';
            }

            if (incerta) {
                duvidas.push(i);
            }
        });

        return { ok: true, respostas: respostas, duvidas: duvidas, bolhas: bolhas, marcas: marcas, raioPx: distancia(aplicar(h, 0, 0), aplicar(h, raio, 0)) };
    }

    return {
        VERSAO: VERSAO,
        layoutCaderno: layoutCaderno,
        lerToken: lerToken,
        paraCinza: paraCinza,
        binarizar: binarizar,
        componentes: componentes,
        homografia: homografia,
        aplicar: aplicar,
        lerCaderno: lerCaderno,
    };
});
