# Turmiza · páginas do celular

- `index.html`: página que o QR code da chamada do Turmiza abre no celular do aluno. Não guarda nada: sem uma chamada
  aberta e um token válido, mostra só "404". Fonte: `resources/pagina-chamada/index.html`, no repositório do Turmiza.
- `correcao/`: correção de provas pelo celular do professor. Lê a foto do caderno de respostas no próprio celular
  (`omr.js`, com o `jsQR.js` 1.4.0, Apache-2.0, para o QR) e manda só as letras ao Apps Script do professor. Sem a
  sessão aberta no Turmiza, mostra só "404". Fonte: `resources/pagina-correcao/`, no repositório do Turmiza.
