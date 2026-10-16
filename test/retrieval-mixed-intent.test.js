'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {intent}=require('../src/retrieval-ranking');
test('a concrete task still retrieves knowledge when it also requests provenance',()=>{
  assert.equal(intent('请根据本轮收到的知识修复新会话发送误停旧会话的问题，并列出知识来源。'),'search');
  assert.equal(intent('请只根据本轮工作台自动注入的项目知识回答：新会话创建尚未返回时为什么会误停止旧任务？请引用你实际收到的提交与知识来源。'),'search');
  assert.equal(intent('本轮你收到的知识来自哪里？'),'followup');
});
