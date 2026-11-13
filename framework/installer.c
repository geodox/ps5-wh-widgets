/* Combined installer: swap bridge579.hbc in for the hub AND run a probe prelude.
 * Verifies the module-579 bridge exposes WIDGET_MAP to globalThis.__wh_map.
 * One slot-2 detour: runs WH_PRELUDE in each runtime (via the original
 * evaluateJavaScript), then swaps the hub buffer (exact size) for our embedded
 * bridge HBC, then runs it. Prelude writes globalThis.__wh_probe when it sees
 * __wh_map; read with heap_find.py WHBRIDGE. */
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <machine/reg.h>
#include <ps5/kernel.h>
#include <ps5/klog.h>
#include <ps5/mdbg.h>
#include <signal.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <poll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <time.h>
#include "wh_detour.h"
#include "wh_sigs.h"

/* ---- payload version ---- */
#define WH_VERSION "26.11.12 beta"

/* full bridge HBC, embedded in the payload: the detour swaps it in for the hub on
 * any firmware, so nothing depends on the hub's exact bytes */
extern const uint8_t bridge_hbc_start[];
extern const uint8_t bridge_hbc_end[];

#define WH_WIDGETS_DIR "/data/wh-widgets"
#define WH_LOADER_HEAD "(function(){var G=globalThis;if(G.__wh_c)return;var LQ=G.__wh_logq||(G.__wh_logq=[]);function LQM(){G.__WHLQ='WHLQ'+LQ.length+'b'+(G.__wh_logb||0)+'s'+(G.__wh_logsent||0)+'X';}function LF(){if(!G.__wh_ishub){if(G.__wh_lpt0&&Date.now()-G.__wh_lpt0>60000){try{G.clearInterval(G.__wh_lp);}catch(e){}G.__wh_lp=-1;LQ.length=0;}return;}if(!LQ.length||G.__wh_logb||typeof G.fetch!=='function')return;var it=LQ[0];G.__wh_logb=1;var done=function(ok,er){G.__wh_logb=0;if(ok)G.__wh_logsent=(G.__wh_logsent||0)+1;else{var em=String((er&&er.message)||er||'?').replace(/[^A-Za-z0-9 ._:-]/g,'').slice(0,60);G.__WHLOGE='WHLOGE_'+em+'X';}if(ok||++it.n>=3){LQ.shift();if(!ok){G.__wh_logfail=(G.__wh_logfail||0)+1;G.__WHLOGF='WHLOGF'+G.__wh_logfail+'X';}}LQM();if(ok&&LQ.length)LF();};try{G.fetch(it.u).then(function(){done(1);},function(e){done(0,e);});}catch(e){done(0,e);}}function HX(t){var o='';t=String(t);for(var i=0;i<t.length&&o.length<800;i++){var c=t.charCodeAt(i);if(c<128)o+=(c<16?'0':'')+c.toString(16);else{try{o+=G.encodeURIComponent(t.charAt(i)).replace(/%/g,'').toLowerCase();}catch(e){o+='3f';}}}return o;}function WL(m,w,f){try{LQ.push({n:0,u:'" WH_ASSET_URL "__log?'+(w?'w='+HX(w)+'&':'')+'h='+HX(String(m).slice(0,400))+(f?'&f=1':'')});if(LQ.length>200)LQ.shift();LQM();}catch(e){G.__WHLOGE='WHLOGEpushX';}}if(!G.__wh_lp){try{G.__wh_lpt0=Date.now();G.__wh_lp=G.setInterval(LF,400);}catch(e){}}if(!G.__wh_wd){G.__wh_wd=1;try{G.setTimeout(function(){try{if(!G.__wh_ishub){G.__WHWD='WHWDnoX';G.fetch('" WH_ASSET_URL "__log?h='+HX('prelude ran but no hub bridge after 10s: the hub bundle was not swapped (stock hub kept) or the hub is still loading'));}}catch(e){}},10000);}catch(e){}}function EM(x){return (x&&x.message)?x.message:String(x);}var W=G.base_dll;if(typeof W!=='function'||!W.c){G.__wh_cfail='nodll';return;}var R,V,T,FL,IM,VEND,ids=G.Object.getOwnPropertyNames(W.c);for(var i=0;i<ids.length;i++){var ex;try{ex=W.c[ids[i]].exports;}catch(e){continue;}if(!ex||typeof ex!=='object')continue;try{if(!R&&ex.createElement&&ex.useState&&ex.Component)R=ex;}catch(e){}try{if(!V&&ex.View&&(ex.View.displayName==='View'||ex.View.name==='View')){V=ex.View;VEND=ex;}}catch(e){}try{if(!T&&ex.Text&&ex.Text.displayName==='Text')T=ex.Text;}catch(e){}try{if(!FL&&ex.FocusLayerPS)FL=ex.FocusLayerPS;}catch(e){}try{if(!IM&&ex.Image&&(ex.Image.resolveAssetSource||ex.Image.displayName==='Image'||ex.Image.getSize))IM=ex.Image;}catch(e){}}if(!R||!V||!T){G.__wh_cfail='noRVT';WL('loader: React/View/Text not found in base_dll ('+(R?'':'React ')+(V?'':'View ')+(T?'':'Text')+') - widgets cannot load',0,1);return;}var ce=R.createElement;function EB(p){R.Component.call(this,p);this.state={e:0};}EB.prototype=G.Object.create(R.Component.prototype);EB.prototype.constructor=EB;EB.getDerivedStateFromError=function(){return{e:1};};EB.prototype.componentDidCatch=function(err){try{G.__wh_err=(G.__wh_err||'')+'['+EM(err)+']';WL('render error (tile hidden): '+EM(err)+(err&&err.stack?' | '+String(err.stack).slice(0,240):''),this.props.wid,1);}catch(e){}};EB.prototype.render=function(){return this.state.e?null:this.props.children;};var wh={React:R,View:V,Text:T,Image:IM,FocusLayerPS:FL,config:null};if(VEND){try{wh.StyleSheet=VEND.StyleSheet;wh.FontSizePS=VEND.FontSizePS;wh.IconPS=VEND.IconPS;wh.I18nPS=VEND.I18nPS;wh.Animated=VEND.Animated;wh.ActivityIndicator=VEND.ActivityIndicator;wh.KeyGuidePS=VEND.KeyGuidePS;wh.OptionsMenuPS=VEND.OptionsMenuPS;wh.MenuListItemPS=VEND.MenuListItemPS;wh.ScrollView=VEND.ScrollView;wh.LayoutAnimation=VEND.LayoutAnimation;wh.findNodeHandle=VEND.findNodeHandle;if(!IM)IM=VEND.Image;}catch(e){}}wh.WidgetSize={MINI:0,MINI_EXPANDED:0.1,MINI_EXPANDED_HEIGHT:0.2,DEFAULT:1,LARGE:2,FULL:3,XL:6};if(!wh.FontSizePS)wh.FontSizePS={Size3XLarge:72,Size2XLarge:54,SizeXLarge:45,SizeLarge:36,SizeNormal:30,SizeSmall:27,SizeXSmall:24,Size2XSmall:21,Size3XSmall:18,Size4XSmall:15};wh.Metrics={WIDGET_WIDTH:504,WIDGET_HEIGHT:152,WIDGET_WIDTH_SPACING:528,WIDGET_SPACING:24,WIDGET_PADDING:16,WIDGET_BORDER_RADIUS:16,MINI_WIDGET_HEIGHT:56,XL_WIDTH:1032,MAT_COLOR:'#17191E'};wh.Button={Cross:'Enter',Circle:'Back',Square:'Square',Triangle:'Triangle',Options:'Options',L1:'L',R1:'R',L2:'L2',R2:'R2',L3:'L3',R3:'R3',Up:'Up',Down:'Down',Left:'Left',Right:'Right'};wh.__btnOk={Enter:1,Square:1,Options:1,Triangle:1,L:1,R:1,L2:1,R2:1,L3:1,R3:1};wh.__LOCKED={canMoveLeft:false,canMoveRight:false,canMoveUp:false,canMoveDown:false};wh.__ctx=function(){if(!wh.__btnCtx)wh.__btnCtx=wh.React.createContext(null);return wh.__btnCtx;};wh.onPressed=function(b,fn){var X=wh.React,c=X.useContext(wh.__ctx()),cx=c&&c.cx,r=X.useRef(fn);r.current=fn;X.useEffect(function(){if(!cx)return;if(!wh.__btnOk[b]){WL('onPressed('+b+') ignored: that button belongs to the system',cx.id);return;}var h={b:b,r:r};cx.hs.push(h);return function(){var i=cx.hs.indexOf(h);if(i>=0)cx.hs.splice(i,1);};},[cx,b]);};wh.Focusable=function(q){var X=wh.React,c=X.useContext(wh.__ctx()),cx=c&&c.cx,me=X.useRef({}),vr=X.useRef(null);me.current.p=q;X.useEffect(function(){if(cx)return cx.reg(me);},[cx]);var f=!!(c&&c.sel===me);var ch=typeof q.children==='function'?q.children(f):q.children;return ce(V,{ref:vr,style:[q.style,f?q.focusedStyle:null],onLayout:function(ev){try{var n=vr.current;if(n&&typeof n.measureInWindow==='function'){n.measureInWindow(function(x,y,w,h){me.current.r={x:x,y:y,w:w,h:h};});}else{var l=ev&&ev.nativeEvent&&ev.nativeEvent.layout;if(l)me.current.r={x:l.x,y:l.y,w:l.width,h:l.height};}}catch(z){}}},ch);};wh.__buildOpts=function(list,vals,setV){var M=wh.MenuListItemPS;if(!M||!list||!list.length)return null;var out=[];for(var i=0;i<list.length;i++){(function(st){var cur=vals[st.id];if(st.type==='toggle'){out.push(ce(M.Switch,{key:st.id,id:st.id,label:st.title,value:!!cur,onValueChange:function(v){setV(st.id,v);}}));}else{var kids=[];for(var j=0;j<st.options.length;j++){(function(o){kids.push(ce(M.Selectable,{key:String(o.value),label:o.label,value:o.value,checked:o.value===cur,onPress:function(){setV(st.id,o.value);}}));})(st.options[j]);}out.push(ce(M.Dropdown,{key:st.id,id:st.id,label:st.title,value:cur,onValueChange:function(v){setV(st.id,v);}},kids));}})(list[i]);}return out;};wh.__hubFrame=function(){if(wh.__hf!==undefined)return wh.__hf;var rq=G.__whRequire;if(typeof rq!=='function')return null;var F=null;try{var m=rq(106);F=m&&(m['default']||null);if(F&&typeof F!=='function'&&!F.$$typeof)F=null;}catch(e){WL('stock frame unavailable: '+EM(e));}try{var hm=rq(77);wh.__hubHeader=(hm&&hm['default'])||null;}catch(e){wh.__hubHeader=null;}wh.__hf=F;WL('stock frame '+(F?'on':'off - using the loader frame')+', stock header '+(wh.__hubHeader?'on':'off'));return F;};wh.dims=function(sz){var H={0:56,0.1:56,0.2:120,1:152,2:328,3:504,6:504};return{width:sz===6?1032:504,height:H[sz]!=null?H[sz]:152};};var FSO={maxLevel:'large'};wh.fontScalingOptions=FSO;wh.TextStyles={label:{fontSize:21},title:{fontSize:21,fontWeight:'bold'},badge:{minWidth:100,textAlign:'right',fontWeight:'normal',fontSize:21}};wh.Label=function(p){var q=G.Object.assign({},p);if(q.numberOfLines===undefined)q.numberOfLines=1;if(q.allowFontScaling===undefined)q.allowFontScaling=FSO;q.style=[wh.TextStyles.label,p.style];return ce(T,q);};wh.Glyph=function(p){var sp=p.spec||{},bx=sp.box||[0,0,1,1],S=p.size||40,pd=(p.pad!=null)?p.pad:0.06,col=p.color||'#ffffff',k=S*(1-2*pd)/Math.max(bx[2],bx[3]),ox=(S-bx[2]*k)/2,oy=(S-bx[3]*k)/2,rs=sp.rects||[],kids=[];for(var i=0;i<rs.length;i++){var r=rs[i];kids.push(ce(V,{key:'g'+i,style:{position:'absolute',left:ox+(r[0]-bx[0])*k,top:oy+(r[1]-bx[1])*k,width:r[2]*k,height:r[3]*k,borderRadius:(r[4]||0)*k,backgroundColor:col}}));}return ce(V,{style:[{width:S,height:S},p.style]},kids);};wh.Title=function(p){var srcs=p.iconImage;if(srcs!=null&&!G.Array.isArray(srcs))srcs=[srcs];srcs=(srcs||[]).filter(function(x){return !!x;});var st=R.useState(0),k=st[0],setK=st[1],okR=R.useRef(false);R.useEffect(function(){okR.current=false;if(!srcs.length||k>=srcs.length)return;var s1=srcs[k],kd1=(typeof s1==='string')?s1.slice(0,5):'obj';var t=G.setTimeout(function(){if(!okR.current){G.__WHIMG='WHIMGto_'+kd1+'_'+k+'X';setK(k+1);}},4000);return function(){G.clearTimeout(t);};},[k,srcs.length]);var HH=wh.__hubHeader;if(HH&&!p.icon&&!srcs.length){var hd=ce(HH,{iconId:p.iconId,style:{flex:1}},p.children);return ce(V,{style:[{flexDirection:'row',alignItems:'center'},p.style]},hd,p.badge!=null?ce(wh.Label,{style:wh.TextStyles.badge},p.badge):null);}var ic=null,ist=[{width:40,height:40,marginRight:4},p.iconStyle];if(p.icon){ic=ce(V,{style:ist},p.icon);}else if(srcs.length&&k<srcs.length&&IM){var s0=srcs[k],kd=(typeof s0==='string')?s0.slice(0,5):'obj';ic=ce(IM,{key:'i'+k,source:(typeof s0==='string')?{uri:s0}:s0,style:ist,onLoad:function(){okR.current=true;G.__WHIMG='WHIMGok_'+kd+'_'+k+'X';},onError:function(){G.__WHIMG='WHIMGerr_'+kd+'_'+k+'X';setK(k+1);}});}else if(p.iconId&&wh.IconPS)ic=ce(wh.IconPS,{iconId:p.iconId,style:ist});var tx=ce(T,{numberOfLines:1,ellipsizeMode:'tail',allowFontScaling:FSO,style:[wh.TextStyles.title,{flex:1},p.textStyle]},p.children);var bd=(p.badge!=null)?ce(T,{numberOfLines:1,allowFontScaling:FSO,style:[wh.TextStyles.badge,p.badgeStyle]},p.badge):null;return ce(V,{style:[{flexDirection:'row',alignItems:'center',height:40},p.style]},ic,tx,bd);};wh.__glyphs={};wh.registerGlyph=function(n,spec){wh.__glyphs[n]=spec;};var IPO=wh.IconPS;wh.__IconPSOrig=IPO;wh.GlyphImage=function(p){var st=R.useState(0),bad=st[0],setBad=st[1],okR=R.useRef(false);R.useEffect(function(){var t=G.setTimeout(function(){if(!okR.current){var r='to';G.__WHGIMG='WHGIMG_'+r+'_'+p.size+'X';WL('glyph image did not load within 4s: '+p.uri+' -> stock '+(p.fallback||'app_welcome'));setBad(1);}},4000);return function(){G.clearTimeout(t);};},[p.uri]);if(bad||!IM)return IPO?ce(IPO,{iconId:p.fallback||'app_welcome',style:p.style}):null;return ce(IM,{source:{uri:p.uri},resizeMode:'contain',style:[p.style,{width:p.size,height:p.size,tintColor:p.color}],onLoad:function(){okR.current=true;var r='ok';G.__WHGIMG='WHGIMG_'+r+'_'+p.size+'X';},onError:function(e){var r='err';G.__WHGIMG='WHGIMG_'+r+'_'+p.size+'X';WL('glyph image failed: '+p.uri+' ('+((e&&e.nativeEvent&&e.nativeEvent.error)||'error')+') -> stock '+(p.fallback||'app_welcome'));setBad(1);}});};wh.__iconPatched=false;function whFlat(st){try{if(VEND&&VEND.StyleSheet&&VEND.StyleSheet.flatten)return VEND.StyleSheet.flatten(st)||{};}catch(e){}var o={};(function f(x){if(!x)return;if(G.Array.isArray(x)){for(var i=0;i<x.length;i++)f(x[i]);}else if(typeof x==='object'){G.Object.assign(o,x);}})(st);return o;}if(IPO){var wrapR=function(p,ref){var id=p&&p.iconId;if(typeof id==='string'&&id.indexOf('wh:')===0){var g=wh.__glyphs[id.slice(3)];if(g){var fs=whFlat(p.style),S=G.Math.min(fs.width||40,fs.height||fs.width||40);var gc=fs.color||fs.tintColor||'#ffffff';if(g.image)return ce(wh.GlyphImage,{uri:g.image,fallback:g.fallback,size:S,color:gc,style:p.style});return ce(wh.Glyph,{spec:g,size:S,color:gc,style:p.style});}}var q=ref?G.Object.assign({},p,{ref:ref}):p;return ce(IPO,q);};var WIP=R.forwardRef?R.forwardRef(wrapR):function(p){return wrapR(p,null);};try{for(var ipk in IPO){if(!(ipk in WIP))WIP[ipk]=IPO[ipk];}}catch(e){}try{WIP.displayName='IconPS';}catch(e){}wh.IconPS=WIP;wh.__hubInit=function(){var ipm='none';try{var dsc=G.Object.getOwnPropertyDescriptor(VEND,'IconPS');if(dsc&&dsc.writable){VEND.IconPS=WIP;ipm='assign';}else if(dsc&&dsc.configurable){G.Object.defineProperty(VEND,'IconPS',{configurable:true,enumerable:true,get:function(){return WIP;}});ipm='define';}else if(!dsc){VEND.IconPS=WIP;ipm='proto';}else{ipm=(dsc.get?'getter':'ro');}}catch(e){ipm='err';}wh.__iconPatched=(VEND&&VEND.IconPS===WIP);G.__WHICON='WHICON_'+ipm+'_'+(wh.__iconPatched?'ok':'no')+'X';};}wh._c=null;wh.register=function(C){wh._c=C;};wh.log=function(m){WL(m);};wh.logger=function(w){return function(m){WL(m,w);};};G.__wh=wh;G.__wh_c=1;wh.__vend=!!VEND;G.__wh_widgets={};G.__wh_cfgs={};G.__wh_order=[];wh.__SIZES=[0,0.1,0.2,1,2,3,6];wh.__normSettings=function(list,id){var out=[],vals={};if(list==null)return {list:out,values:vals};if(!G.Array.isArray(list)){WL('config.json settings ignored: must be an array',id);return {list:out,values:vals};}for(var i=0;i<list.length;i++){var e=list[i];if(!e||typeof e!=='object'||typeof e.id!=='string'||!e.id){WL('config.json settings['+i+'] ignored: needs a string id',id);continue;}var t=e.type||(G.Array.isArray(e.options)?'choice':'toggle');if(t==='choice'){var op=[];if(G.Array.isArray(e.options))for(var j=0;j<e.options.length;j++){var o=e.options[j];if(o&&typeof o==='object'&&o.value!==undefined)op.push({value:o.value,label:String(o.label!=null?o.label:o.value)});else if(typeof o==='string'||typeof o==='number')op.push({value:o,label:String(o)});}if(!op.length){WL('config.json setting '+e.id+' ignored: choice needs options',id);continue;}var d=e['default'],ok=false;for(var q=0;q<op.length;q++)if(op[q].value===d)ok=true;out.push({id:e.id,title:String(e.title||e.id),type:'choice',options:op,'default':ok?d:op[0].value});vals[e.id]=ok?d:op[0].value;}else if(t==='toggle'){var dv=!!e['default'];out.push({id:e.id,title:String(e.title||e.id),type:'toggle','default':dv});vals[e.id]=dv;}else WL('config.json setting '+e.id+' ignored: unknown type '+t,id);}return {list:out,values:vals};};wh.__begin=function(cfg,raw){var x=null;if(raw){try{x=G.JSON.parse(raw);}catch(e){WL('config.json is not valid JSON ('+EM(e)+'); only id/title/icon fields used',cfg.id);}}if(x&&typeof x==='object'&&!G.Array.isArray(x)){var m={};for(var k in x)if(G.Object.prototype.hasOwnProperty.call(x,k))m[k]=x[k];for(var k2 in cfg)m[k2]=cfg[k2];cfg=m;}if(cfg.sizes!=null){var sz=G.Array.isArray(cfg.sizes)?cfg.sizes.filter(function(v){return wh.__SIZES.indexOf(v)>=0;}).sort(function(a,b){return a-b;}):[];if(!sz.length){WL('config.json sizes ignored: use values from '+wh.__SIZES.join(', '),cfg.id);sz=null;}cfg.sizes=sz;}var ns=wh.__normSettings(cfg.settings,cfg.id);cfg.settings=ns.list;cfg.__settingDefaults=ns.values;wh.config=cfg;wh._c=null;wh.__ferr=null;};wh.__fail=function(e){wh._c=null;wh.__ferr=e;};wh.__end=function(){var cfg=wh.config,C=wh._c;if(!C){G.__wh_err=(G.__wh_err||'')+'[noreg:'+((cfg&&cfg.id)||'?')+']';WL(wh.__ferr?'not loaded: widget.js threw: '+EM(wh.__ferr):'not loaded: widget.js ran but never called wh.register(Component)',cfg&&cfg.id,1);return;}var id=cfg.id,WD={};function TPL(tp){var mk=tp&&tp.__whMk;return mk?mk(!!tp.focusable):null;}function Wrapped(p){p=p||{};var s=R.useState(false),foc=s[0],setF=s[1],xs=R.useState(0),idx=xs[0],setIdx=xs[1],es=R.useState(false),ent=es[0],setEnt=es[1],ss=R.useState(cfg.__settingDefaults||{}),sv=ss[0],setSv=ss[1],omR=R.useRef(null),tref=R.useRef(null),loadedR=R.useRef(false),bump=R.useState(0)[1],cr=R.useRef(null);if(!cr.current){var cx0={id:id,hs:[],items:[]};cx0.reg=function(me){cx0.items.push(me);bump(function(n){return n+1;});return function(){var i=cx0.items.indexOf(me);if(i>=0)cx0.items.splice(i,1);bump(function(n){return n+1;});};};cr.current=cx0;}var cx=cr.current,nI=cx.items.length,ci=nI?Math.min(idx,nI-1):-1,act=!!(ent&&foc&&!p.editing&&ci>=0),sel=act?cx.items[ci]:null;R.useEffect(function(){if(!act)return;var tok=G.__wh_lockTok=(G.__wh_lockTok||0)+1;G.__wh_lock=id;G.__wh_exit=function(){setEnt(false);};var BH=null,sub=null,bf=function(){if(!G.__wh_lock)return false;try{if(typeof G.__wh_exit==='function')G.__wh_exit();}catch(z){}return true;};try{BH=VEND&&VEND.BackHandler;if(BH&&BH.addEventListener)sub=BH.addEventListener('hardwareBackPress',bf);}catch(z){}if(!wh.__bhLog){wh.__bhLog=1;WL('focus lock on (BackHandler '+(BH?'hooked':'not found')+')',id);}return function(){G.setTimeout(function(){if(G.__wh_lockTok===tok){if(G.__wh_lock===id)G.__wh_lock=0;G.__wh_exit=null;}try{if(sub&&typeof sub.remove==='function')sub.remove();else if(BH&&BH.removeEventListener)BH.removeEventListener('hardwareBackPress',bf);}catch(z){}},300);};},[act]);R.useEffect(function(){if(!(cfg.settings&&cfg.settings.length)){loadedR.current=true;return;}var done=function(saved){if(saved&&typeof saved==='object'){var n=G.Object.assign({},cfg.__settingDefaults);for(var k in saved)if(G.Object.prototype.hasOwnProperty.call(saved,k)&&(k in n))n[k]=saved[k];setSv(n);}loadedR.current=true;};try{G.fetch('" WH_ASSET_URL "__wget?w='+id).then(function(r){return r.json();}).then(done,function(){done(null);});}catch(e){done(null);}},[]);R.useEffect(function(){if(!loadedR.current||!(cfg.settings&&cfg.settings.length))return;try{G.fetch('" WH_ASSET_URL "__wset?w='+id+'&h='+HX(G.JSON.stringify(sv)));}catch(e){}},[sv]);var sz=(p.size!=null)?p.size:(cfg.size!=null?cfg.size:1),dm=wh.dims(sz),w=dm.width;var el=ce(wh.__ctx().Provider,{value:{cx:cx,sel:sel}},ce(EB,{wid:id},ce(C,{config:cfg,settings:sv,focused:foc,active:act,editing:!!p.editing,size:sz,width:dm.width,height:dm.height})));if(!FL&&!G.__whRequire)return el;var cp=G.Object.assign({},p,{id:id,name:id});function setSetting(k,v){setSv(function(o){var n=G.Object.assign({},o);n[k]=v;return n;});if(!wh.__setLog)wh.__setLog={};if(!wh.__setLog[id+k]){wh.__setLog[id+k]=1;WL('setting '+k+' changed',id);}}var hasOpts=!!(cfg.settings&&cfg.settings.length&&wh.OptionsMenuPS&&wh.MenuListItemPS);function RUN(f,k,e,w){if(!wh.__btnLog)wh.__btnLog={};if(!wh.__btnLog[id+k+w]){wh.__btnLog[id+k+w]=1;WL('button '+k+' handled ('+w+')',id);}var r=true;try{r=f(e)!==false;}catch(x){G.__wh_err=(G.__wh_err||'')+'[btn:'+EM(x)+']';WL('button '+k+' handler threw: '+EM(x),id);}if(r)STOP(e,k);return r;}function STOP(e,k){try{if(e)e.cancelBubble=true;}catch(z){}}function MOVE(k){var dx=k==='Left'?-1:k==='Right'?1:0,dy=k==='Up'?-1:k==='Down'?1:0,cur=cx.items[ci],a=cur&&cur.current.r,best=-1;if(!dx&&!dy)best=ci+(k==='R'?1:-1);else if(a){var ax=a.x+a.w/2,ay=a.y+a.h/2,bs=1e9;for(var i=0;i<nI;i++){if(i===ci)continue;var b=cx.items[i].current.r;if(!b)continue;var bx=b.x+b.w/2,by=b.y+b.h/2,pr=(bx-ax)*dx+(by-ay)*dy;if(pr<=1)continue;var sc=pr+2*Math.abs(dx?(by-ay):(bx-ax));if(sc<bs){bs=sc;best=i;}}}else best=ci+((dx>0||dy>0)?1:-1);if(best>=0&&best<nI)setIdx(best);}function BK(k,e){if(p.editing)return false;if(act){var ip=sel.current.p,f=k==='Enter'?ip.onPress:(ip.buttons&&ip.buttons[k]);if(typeof f==='function'&&RUN(f,k,e,'item'))return true;if(k==='Back'){setEnt(false);STOP(e,k);return true;}if(k==='L'||k==='R'||k==='Up'||k==='Down'||k==='Left'||k==='Right'){MOVE(k);STOP(e,k);return true;}}else if(k==='Options'&&hasOpts&&foc){var r=omR.current;if(r&&r.open){r.open();STOP(e,k);if(!wh.__omLog){wh.__omLog=1;WL('settings menu opened',id);}return true;}}else if(k==='Enter'&&nI>0&&foc){setEnt(true);STOP(e,k);if(!wh.__entLog){wh.__entLog=1;WL('entered (X): arrows move, Circle leaves',id);}return true;}if(k==='Back'||k==='Up'||k==='Down'||k==='Left'||k==='Right')return false;for(var i=cx.hs.length-1;i>=0;i--){var h=cx.hs[i];if(h.b===k&&typeof h.r.current==='function'&&RUN(h.r.current,k,e,'tile'))return true;}return false;}function MK(fz){return ce(V,{ref:tref,focusable:fz,name:id,focusCustomSettings:act?wh.__LOCKED:undefined,style:{width:w,height:dm.height,borderRadius:16,overflow:'hidden'},onFocus:function(e){setF(true);try{if(p.onFocus)p.onFocus({component:{props:cp},originalEvent:e});}catch(x){G.__wh_err=(G.__wh_err||'')+'[foc:'+EM(x)+']';WL('focus forwarding failed: '+EM(x),id);}},onBlur:function(){setF(false);setEnt(false);},onPress:function(e){try{if(p.editing&&p.onPressEdit)return p.onPressEdit();}catch(x){G.__wh_err=(G.__wh_err||'')+'[press:'+EM(x)+']';WL('edit press forwarding failed: '+EM(x),id);}return BK('Enter',e);},onSquareKeyDown:function(e){return BK('Square',e);},onOptionsKeyDown:function(e){return BK('Options',e);},onLKeyDown:function(e){return BK('L',e);},onRKeyDown:function(e){return BK('R',e);},onL2KeyDown:function(e){return BK('L2',e);},onR2KeyDown:function(e){return BK('R2',e);},onL3KeyDown:function(e){return BK('L3',e);},onR3KeyDown:function(e){return BK('R3',e);},onUpKeyDown:act?function(e){return BK('Up',e);}:undefined,onDownKeyDown:act?function(e){return BK('Down',e);}:undefined,onLeftKeyDown:act?function(e){return BK('Left',e);}:undefined,onRightKeyDown:act?function(e){return BK('Right',e);}:undefined,onBackKeyDown:act?function(e){return BK('Back',e);}:undefined,onTriangleKeyDown:act?function(e){return BK('Triangle',e);}:undefined},el);}function OM(){if(!hasOpts)return null;var items=wh.__buildOpts(cfg.settings,sv,setSetting);try{return ce(wh.OptionsMenuPS,{ref:omR,targetComponent:tref.current,contextItems:items,onRequestClose:function(){},initialFocusItem:{sectionIndex:0,itemIndex:0}});}catch(e){if(!wh.__omErr){wh.__omErr=1;WL('OptionsMenuPS render failed: '+EM(e),id);}return null;}}function HINT(){if(!wh.KeyGuidePS||p.editing||!foc)return null;var g={};if(nI){g.enter=act?'Select':'Edit';}if(act){g.back='Done';if(nI>1){g.l1='Prev';g.r1='Next';}}if(hasOpts&&!act)g.options='Settings';if(!G.Object.keys(g).length)return null;try{return ce(wh.KeyGuidePS,G.Object.assign({autoHideBehavior:'none',style:{position:'absolute',left:0,right:0,bottom:0}},g));}catch(e){if(!wh.__hintErr){wh.__hintErr=1;WL('KeyGuidePS render failed: '+EM(e),id);}return null;}}var HF=wh.__hubFrame();if(HF)return ce(V,null,ce(EB,{wid:id},ce(HF,G.Object.assign({},p,{name:id,id:id,data:WD,Template:TPL,templateFocusable:true,templateProps:{__whMk:MK}}))),OM(),HINT());return ce(V,null,ce(FL,{style:{width:w}},MK(p.focusable!==false)),OM(),HINT());}if(cfg.glyph&&cfg.assetBase)wh.registerGlyph(id,{image:cfg.assetBase+cfg.glyph,fallback:cfg.iconFallback});WL('loaded (size '+(cfg.size!=null?cfg.size:1)+(cfg.glyph?', glyph '+cfg.glyph:'')+')',id);Wrapped.__whId=id;G.__wh_widgets[id]=Wrapped;G.__wh_cfgs[id]=cfg;G.__wh_order.push(id);};wh.__map=null;wh.__editable=null;wh.__register=function(){var M=wh.__map;if(!M){try{M=G['__whWidgetMap'];}catch(e){}}if(!M||typeof M!=='object')return false;var o=G.__wh_order;for(var i=0;i<o.length;i++){try{M[o[i]]=G.__wh_widgets[o[i]];}catch(e){}}G.__wh_reg=o.length;if(!wh.__regLogged){wh.__regLogged=1;G.__WHREGLOG='WHREGLOG'+o.length+'X';WL('hub registered '+o.length+' widget(s) ['+o.join(', ')+']; WIDGET_MAP now '+G.Object.keys(M).length);}G.__WHDIAG='WHDIAGreg'+o.length+'of'+(M?G.Object.keys(M).length:0)+'X';return true;};wh.__metaKeys=[['__whTitles','title'],['__whIcons','iconId'],['__whDescs','description']];wh.__meta={};wh.__metaFill=function(g,f){var M=wh.__meta[g];if(!M||typeof M!=='object')return;var o=G.__wh_order;for(var i=0;i<o.length;i++){try{var c=G.__wh_cfgs[o[i]]||{};var v=c[f];if(!v&&f==='title')v=o[i];if(!v&&f==='iconId')v='app_welcome';if(f==='iconId'&&typeof v==='string'&&v.indexOf('wh:')===0&&!wh.__iconPatched)v=c.iconFallback||'app_welcome';M[o[i]]=v||'';}catch(e){G.__wh_err=(G.__wh_err||'')+'[meta:'+g+':'+EM(e)+']';WL('edit list '+f+' not set: '+EM(e),o[i]);}}G['__wh_m_'+g]=o.length;if(!wh['__ml_'+g]){wh['__ml_'+g]=1;WL('edit list '+f+' set for '+o.length+' widget(s)');}};wh.__metaAll=function(){var k=wh.__metaKeys;for(var i=0;i<k.length;i++)wh.__metaFill(k[i][0],k[i][1]);};wh.__install=function(){var GN=['__whWidgetMap','__whEditable'],MK0=wh.__metaKeys,PV={};for(var gi=0;gi<MK0.length;gi++)GN.push(MK0[gi][0]);for(var gi=0;gi<GN.length;gi++){try{var dsc=G.Object.getOwnPropertyDescriptor(G,GN[gi]);if(dsc&&('value' in dsc)&&dsc.value)PV[GN[gi]]=dsc.value;}catch(e){}}try{G.Object.defineProperty(G,'__whWidgetMap',{configurable:true,get:function(){return wh.__map;},set:function(M){wh.__map=M;if(!G.__wh_ishub){G.__wh_ishub=1;try{if(wh.__hubInit)wh.__hubInit();wh.__metaAll();}catch(e){}WL('loader ready in the hub runtime (vendor '+(wh.__vend?'ok':'MISSING')+', icons '+(wh.__iconPatched?'wrapped':'NOT wrapped - wh: glyphs fall back')+')');}try{wh.__register();}catch(e){G.__wh_err=(G.__wh_err||'')+'[set:'+EM(e)+']';WL('registering into WIDGET_MAP failed: '+EM(e),0,1);}}});G.Object.defineProperty(G,'__whEditable',{configurable:true,get:function(){return wh.__editable;},set:function(E){wh.__editable=E;try{var o=G.__wh_order;for(var i=0;i<o.length;i++){E['__wh_'+o[i]]=o[i];}G.__wh_ed=o.length;}catch(e){G.__wh_err=(G.__wh_err||'')+'[sed:'+EM(e)+']';WL('marking widgets editable failed (edit mode would drop them): '+EM(e));}}});var MK=wh.__metaKeys;for(var mi=0;mi<MK.length;mi++){(function(g,f){G.Object.defineProperty(G,g,{configurable:true,get:function(){return wh.__meta[g];},set:function(M){wh.__meta[g]=M;wh.__metaFill(g,f);}});})(MK[mi][0],MK[mi][1]);}for(var pk in PV){try{G[pk]=PV[pk];}catch(e){}}G.__WHDIAG=(G.__WHDIAG||'')+'WHDIAGinstalledX';}catch(e){G.__wh_err=(G.__wh_err||'')+'[def:'+EM(e)+']';G.__WHDIAG='WHDIAGdeffailX';WL('installing registry hooks failed: '+EM(e),0,1);}};wh.__flush=function(){wh.__install();wh.__metaAll();if(wh.__register())return;var n=0;var iv=G.setInterval(function(){n++;if(wh.__register()||n>160){try{G.clearInterval(iv);}catch(e){}}},50);};})();"

/* FW 13.20 reference offsets: used only to label a match in the log; the real
 * addresses are discovered at runtime by signature (see wh_discover). */
#define OFF_EVALUATE_JS  0x0000e890u
#define OFF_VTABLE_SLOT2 0x0026c358u
/* hub is now detected by content (WH_NEEDLE in wh_detour.h), not by exact size */
#define WH_MOD_CAP       0x00800000u   /* hard cap when walking the module image */
static const uint8_t EXPECTED_PROLOGUE[11] =
    {0x55,0x48,0x89,0xe5,0x41,0x56,0x53,0x48,0x83,0xec,0x20};

/* cave layout */
#define CV_DET     0x000
#define CV_PSIZE   0x100
#define CV_PDATA   0x120
#define CV_DTOR    0x140
#define CV_PVT     0x160
#define CV_PBUF    0x1a0
#define CV_PCTRL   0x1c0
#define CV_PSHARED 0x1e0
#define CV_URL     0x200
#define CV_BSIZE   0x220
#define CV_BDATA   0x240
#define CV_BVT     0x260
#define CV_BBUF    0x2a0
#define CV_BCTRL   0x2c0
#define CV_BSHARED 0x2e0
#define CV_CTR     0x300
#define CV_SIG     0x320   /* "WHBRIDGE", bridge len, bridge FNV-1a64, version */
#define CV_NEEDLE  0x340   /* hub signature string ("widget:customTemplates") */
#define CV_MATCH   0x360   /* choose_buffer helper (content-detects the hub) */
#define CV_PRELUDE 0x500   /* spliced loader + widget JS */
#define WH_SIG_VER 1
/* diagnostic dump staging (opt-in via /data/wh-widgets/.wh_dump) */
#define WH_DUMP_FLAG "/data/wh-widgets/.wh_dump"
#define WH_DUMP_CAP  8
#define WH_DUMP_SLOT ((size_t)1 << WH_DUMP_SHIFT)
#define WH_DCAVE_SZ  (WH_DUMP_HDR + (size_t)WH_DUMP_CAP * WH_DUMP_SLOT)

/* ---- log file: /data/wh-widgets/wh.log (rotates to wh.log.1 at 256 KB) ---- */
#define WH_LOG_FILE  "/data/wh-widgets/wh.log"
#define WH_LOG_OLD   "/data/wh-widgets/wh.log.1"
#define WH_LOG_MAX   (256*1024)
static void wh_flog(const char* tag, const char* fmt, ...) {
  char msg[600]; va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof msg, fmt, ap); va_end(ap);
  size_t n = strlen(msg); while (n && (msg[n-1] == '\n' || msg[n-1] == '\r')) msg[--n] = 0;
  for (size_t i = 0; i < n; i++) if ((unsigned char)msg[i] < 32) msg[i] = ' ';   /* one line per entry */
  struct stat st;
  if (!stat(WH_LOG_FILE, &st) && st.st_size > WH_LOG_MAX) rename(WH_LOG_FILE, WH_LOG_OLD);
  int fd = open(WH_LOG_FILE, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0644);
  if (fd < 0) return;
  char ts[32] = "(no clock)"; time_t t = time(0); struct tm tmv;
  if (localtime_r(&t, &tmv)) strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tmv);
  char line[720]; int l = snprintf(line, sizeof line, "%s [%s] %s\n", ts, tag, msg);
  if (l > 0) { ssize_t w = write(fd, line, (size_t)(l < (int)sizeof line ? l : (int)sizeof line - 1)); (void)w; }
  close(fd);
}
#define LOG(...) do { char _lb[600]; snprintf(_lb, sizeof _lb, __VA_ARGS__); \
  klog_printf("[wc] %s", _lb); printf("[wc] %s", _lb); wh_flog("installer", "%s", _lb); } while (0)
static void put64(uint8_t *b, uint64_t v) { memcpy(b, &v, 8); }
static uint64_t get64(const uint8_t *b) { uint64_t v; memcpy(&v, b, 8); return v; }
static uint64_t fnv1a64(const uint8_t *p, size_t n) {
  uint64_t h = 0xcbf29ce484222325ull;
  while (n--) { h ^= *p++; h *= 0x100000001b3ull; }
  return h;
}

typedef struct notify_request { char u[45]; char message[3075]; } notify_request_t;
int sceKernelSendNotificationRequest(int, notify_request_t*, size_t, int);
static void notify(const char *fmt, ...) {
  notify_request_t req; va_list ap; bzero(&req, sizeof req);
  va_start(ap, fmt); vsnprintf(req.message, sizeof req.message, fmt, ap); va_end(ap);
  sceKernelSendNotificationRequest(0, &req, sizeof req, 0);
}

#define KP_PID_OFF 72
static int scan_needle(const uint8_t *p, int size, const char *n, size_t nl) {
  for (int i = 0; i + (int)nl + 1 <= size; i++)
    if (p[i] == n[0] && !memcmp(p + i, n, nl) && p[i + nl] == '\0') return i;
  return -1;
}
static pid_t find_pid(const char *comm) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PROC, 0};
  pid_t me = getpid(), found = -1; size_t sz, nl = strlen(comm); uint8_t *buf;
  if (sysctl(mib, 4, NULL, &sz, NULL, 0)) return -1;
  if (!(buf = malloc(sz))) return -1;
  if (sysctl(mib, 4, buf, &sz, NULL, 0)) { free(buf); return -1; }
  for (uint8_t *p = buf; p < buf + sz; ) {
    int ss = *(int *)p; if (ss <= 0 || p + ss > buf + sz) break;
    pid_t pid = *(pid_t *)(p + KP_PID_OFF);
    if (scan_needle(p, ss, comm, nl) >= 0 && pid != me) found = pid;
    p += ss;
  }
  free(buf); return found;
}
static int sys_ptrace(int req, pid_t pid, caddr_t addr, int data) {
  uint8_t pc[16]; memset(pc, 0xff, sizeof pc);
  pid_t me = getpid(); uint8_t caps[16]; uint64_t authid; int ret;
  if (!(authid = kernel_get_ucred_authid(me))) return -1;
  if (kernel_get_ucred_caps(me, caps)) return -1;
  if (kernel_set_ucred_authid(me, 0x4800000000010003l)) return -1;
  if (kernel_set_ucred_caps(me, pc)) return -1;
  ret = (int)__syscall(SYS_ptrace, req, pid, addr, data);
  kernel_set_ucred_authid(me, authid); kernel_set_ucred_caps(me, caps);
  return ret;
}
static int ptg(pid_t pid, struct reg *r){ return sys_ptrace(PT_GETREGS, pid,(caddr_t)r,0); }
static int pts(pid_t pid, struct reg *r){ return sys_ptrace(PT_SETREGS, pid,(caddr_t)r,0); }
static int remote_read(pid_t pid, uintptr_t a, void *o, size_t l) { return mdbg_copyout(pid, (intptr_t)a, o, l); }
/* ---- runtime discovery of the hook point (no hardcoded offsets) -------------
 * Find evaluateJavaScript and its JSI vtable slot in libhermes by content, so the
 * same payload works across firmwares. Validated on FW 13.20 (matches 0xe890 /
 * 0x26c358). Steps: walk the module's page protections to bound .text and the
 * read-only image; signature-scan .text for evaluateJavaScript / prepareJavaScript
 * / evaluatePreparedJavaScript (each must be unique); locate the vtable by the
 * (prepare, evalPrepared) pointer pair in rodata -> slot 2 = pair - 8 (works even
 * while slot 2 is already hooked, since those two neighbours are never touched). */
static intptr_t wh_find_unique(const uint8_t* buf, size_t n, const uint8_t* pat, const uint8_t* msk, size_t plen){
  intptr_t found = -1;
  if (plen == 0 || n < plen) return -1;
  for (size_t i = 0; i + plen <= n; i++){
    size_t k = 0;
    for (; k < plen; k++) if (msk[k] && buf[i+k] != pat[k]) break;
    if (k == plen){ if (found >= 0) return -2; found = (intptr_t)i; }
  }
  return found;   /* -1 none, -2 ambiguous, else offset */
}
/* unique 16-byte little-endian pair (a,b) within [buf,buf+n): offset, or -1/-2 */
static intptr_t wh_find_pair(const uint8_t* buf, size_t n, uint64_t a, uint64_t b){
  uint8_t pair[16]; memcpy(pair, &a, 8); memcpy(pair+8, &b, 8);
  intptr_t found = -1;
  if (n < 16) return -1;
  for (size_t i = 0; i + 16 <= n; i++){
    if (!memcmp(buf + i, pair, 16)){ if (found >= 0) return -2; found = (intptr_t)i; }
  }
  return found;
}
/* discover eval fn + vtable slot; 0 on success, else an rc code */
static int wh_discover(pid_t pid, uintptr_t base, uintptr_t* eval_out, uintptr_t* slot_out){
  /* bound the module: walk pages while mapped (protection query >= 0). PS5 maps
   * code execute-only (XOM: EXEC set, READ clear) and the kernel still copies it,
   * so bound on the unmapped gap, not the READ bit. text_end = first non-exec page. */
  uintptr_t p = base, text_end = 0;
  while (p - base < WH_MOD_CAP){
    int pr = kernel_get_vmem_protection(pid, p, 1);
    if (pr < 0) break;                             /* unmapped: end of the module image */
    if (!text_end && !(pr & PROT_EXEC)) text_end = p;
    p += 0x1000;
  }
  uintptr_t img_end = p;
  if (!text_end) text_end = img_end;
  size_t imglen = img_end - base, textlen = text_end - base;
  if (imglen < 0x10000 || textlen < 0x1000){ LOG("discover: module too small (img %#zx text %#zx)\n", imglen, textlen); return 40; }
  uint8_t* mod = (uint8_t*)malloc(imglen);
  if (!mod){ LOG("discover: oom %#zx\n", imglen); return 41; }
  for (size_t o = 0; o < imglen; ){ size_t n = imglen - o; if (n > 0x40000) n = 0x40000;
    if (remote_read(pid, base + o, mod + o, n)){ LOG("discover: read fail at +%#zx\n", o); free(mod); return 42; } o += n; }
  LOG("discover: module +0..%#zx text +0..%#zx\n", imglen, textlen);
  /* signature-scan .text */
  intptr_t ev = wh_find_unique(mod, textlen, WH_SIG_EVAL_P, WH_SIG_EVAL_M, sizeof WH_SIG_EVAL_P);
  intptr_t pr_ = wh_find_unique(mod, textlen, WH_SIG_PREPARE_P, WH_SIG_PREPARE_M, sizeof WH_SIG_PREPARE_P);
  intptr_t ep = wh_find_unique(mod, textlen, WH_SIG_EVALPREP_P, WH_SIG_EVALPREP_M, sizeof WH_SIG_EVALPREP_P);
  if (ev < 0 || pr_ < 0 || ep < 0){
    LOG("discover: signature match eval=%ld prepare=%ld evalPrepared=%ld (<0: -1 none, -2 ambiguous)\n",(long)ev,(long)pr_,(long)ep);
    free(mod); return 43;
  }
  uintptr_t evalA = base + ev, prepA = base + pr_, eprepA = base + ep;
  /* vtable slot via the (prepare, evalPrepared) pair in the data region */
  intptr_t pr_off = wh_find_pair(mod + textlen, imglen - textlen, (uint64_t)prepA, (uint64_t)eprepA);
  if (pr_off < 0){ LOG("discover: vtable pair %s\n", pr_off==-2?"ambiguous":"not found"); free(mod); return 44; }
  uintptr_t slot3 = text_end + (uintptr_t)pr_off, slot2 = slot3 - 8;
  free(mod);
  LOG("discover: eval +%#lx prepare +%#lx evalPrepared +%#lx slot2 +%#lx%s\n",
      (long)(evalA-base),(long)(prepA-base),(long)(eprepA-base),(long)(slot2-base),
      (evalA-base==OFF_EVALUATE_JS && slot2-base==OFF_VTABLE_SLOT2) ? " (matches FW 13.20)" : " (non-13.20 layout)");
  *eval_out = evalA; *slot_out = slot2;
  return 0;
}
static int remote_write_d(pid_t pid, uintptr_t a, const void *s, size_t l) {
  struct ptrace_io_desc iod = {0}; iod.piod_op = PIOD_WRITE_D; iod.piod_offs=(void*)a; iod.piod_addr=(void*)s; iod.piod_len=l;
  return sys_ptrace(PT_IO, pid, (caddr_t)&iod, 0);
}
static int remote_write_chunked(pid_t pid, uintptr_t a, const uint8_t *s, size_t l) {
  const size_t CH=0x10000;
  for (size_t o=0;o<l;o+=CH){ size_t n=l-o; if(n>CH)n=CH; if(remote_write_d(pid,a+o,s+o,n)){LOG("chunk @%#zx fail\n",o);return -1;} }
  return 0;
}
#define SYS_mmap 477
static uintptr_t gadget_of(pid_t pid){ intptr_t a=kernel_dynlib_resolve(pid,0x1,"HoLVWNanBBc"); if(!a)a=kernel_dynlib_resolve(pid,0x2001,"HoLVWNanBBc"); return a?(uintptr_t)a+0xa:0; }
static int remote_syscall(pid_t pid, uintptr_t g, uint64_t sn, uint64_t a0,uint64_t a1,uint64_t a2,uint64_t a3,uint64_t a4,uint64_t a5, uint64_t *ret){
  struct reg bak,jmp; if(ptg(pid,&bak))return -1; jmp=bak;
  jmp.r_rax=(int64_t)sn; jmp.r_rdi=a0;jmp.r_rsi=a1;jmp.r_rdx=a2;jmp.r_r10=a3;jmp.r_r8=a4;jmp.r_r9=a5; jmp.r_rip=(int64_t)g;
  if(pts(pid,&jmp))return -1; int rc=-1;
  for(int i=0;i<1000;i++){ if(sys_ptrace(PT_STEP,pid,(caddr_t)1,0))break; if(waitpid(pid,0,0)==-1)break; if(ptg(pid,&jmp))break; if((uint64_t)jmp.r_rsp>(uint64_t)bak.r_rsp){*ret=(uint64_t)jmp.r_rax;rc=0;break;} }
  if(pts(pid,&bak))rc=-1; return rc;
}
static uintptr_t remote_mmap(pid_t pid, uintptr_t g, size_t len, int exec){
  uint64_t ret=0; if(remote_syscall(pid,g,SYS_mmap,0,len,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,(uint64_t)-1,0,&ret))return 0;
  if(ret==(uint64_t)MAP_FAILED||!ret)return 0;
  if(exec&&kernel_mprotect(pid,(intptr_t)ret,len,PROT_READ|PROT_WRITE|PROT_EXEC))return 0;
  return (uintptr_t)ret;
}

/* ---- drop-folder loader: build the prelude from /data/wh-widgets/ ----
 * Generic loader head + one spliced section per widget folder:
 *   __wh.__begin({id,title,iconId,description,size}); <widget.js verbatim>; __wh.__end();
 * widget.js is compiled as part of the prelude (Hermes release blocks in-JS
 * eval), so a syntax error in one widget breaks the set -- validate offline. */
static int wh_read_file(const char* path, char** buf, size_t* len){
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st) || st.st_size <= 0) { close(fd); return -1; }
  size_t n = (size_t)st.st_size;
  char* b = (char*)malloc(n + 1);
  if (!b) { close(fd); return -1; }
  size_t got = 0; ssize_t r;
  while (got < n && (r = read(fd, b + got, n - got)) > 0) got += (size_t)r;
  close(fd);
  b[got] = 0; *buf = b; *len = got; return 0;
}
static int wh_json_str(const char* j, const char* key, char* out, size_t cap){
  char pat[80]; snprintf(pat, sizeof pat, "\"%s\"", key);
  const char* p = strstr(j, pat); if (!p) return -1;
  p += strlen(pat);
  while (*p && *p != ':') p++;
  if (*p != ':') return -1; p++;
  while (*p==' '||*p=='\t'||*p=='\n'||*p=='\r') p++;
  if (*p != '"') return -1; p++;
  size_t i = 0;
  while (*p && *p != '"' && i < cap-1) { if (*p=='\\' && p[1]) p++; out[i++] = *p++; }
  out[i] = 0; return 0;
}
static double wh_json_num(const char* j, const char* key, double def){
  char pat[80]; snprintf(pat, sizeof pat, "\"%s\"", key);
  const char* p = strstr(j, pat); if (!p) return def;
  p += strlen(pat);
  while (*p && *p != ':') p++;
  if (*p != ':') return def; p++;
  return strtod(p, 0);
}
static void wh_app(char** buf, size_t* len, size_t* cap, const char* s, size_t n){
  if (*len + n + 1 > *cap) { while (*len + n + 1 > *cap) *cap *= 2; *buf = (char*)realloc(*buf, *cap); }
  memcpy(*buf + *len, s, n); *len += n; (*buf)[*len] = 0;
}
#define WHAPP(s) wh_app(&out,&len,&cap,(s),strlen(s))
static void wh_app_esc(char** buf, size_t* len, size_t* cap, const char* s){
  for (; *s; s++){ char c=*s; if (c=='\''||c=='\\'){ char e[2]={'\\',c}; wh_app(buf,len,cap,e,2); } else if (c=='\n'||c=='\r'){ } else wh_app(buf,len,cap,&c,1); }
}
/* ---- widget asset server ------------------------------------------------
 * The hub's Image component only loads http:// (data:/file: URIs fail), so the
 * installer stays resident and serves widget images to ShellUI over loopback.
 * Deliberately minimal and locked down:
 *   - binds 127.0.0.1 only (unreachable from the LAN); one request at a time
 *   - GET only; request line capped at 1 KB; 2 s read/write timeouts
 *   - path must be exactly /<dir>/<file>, each [A-Za-z0-9._-]{1,64}, no leading
 *     '.', no ".."; served from WH_WIDGETS_DIR only, O_NOFOLLOW, regular files
 *   - image types only (.png .jpg .jpeg), <= 1 MB; no listings, no other methods */
#define WH_ASSET_PORT 8098
#define WH_ASSET_MAX  (1024*1024)
#define WH_ASSET_URL  "http://127.0.0.1:8098/"
#define WH_GEN_FILE   WH_WIDGETS_DIR "/.wh_gen"
static int wh_name_ok(const char* s, size_t n){
  if (!n || n > 64 || s[0] == '.') return 0;
  for (size_t i = 0; i < n; i++){
    char c = s[i];
    if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='.'||c=='_'||c=='-')) return 0;
    if (c == '.' && i+1 < n && s[i+1] == '.') return 0;
  }
  return 1;
}
static const char* wh_img_type(const char* f){
  const char* e = strrchr(f, '.');
  if (!e) return 0;
  if (!strcmp(e,".png")) return "image/png";
  if (!strcmp(e,".jpg") || !strcmp(e,".jpeg")) return "image/jpeg";
  return 0;
}
static void wh_send_all(int c, const void* b, size_t n){
  const char* p = (const char*)b;
  while (n){ ssize_t w = write(c, p, n); if (w <= 0) return; p += w; n -= (size_t)w; }
}
static void wh_reply(int c, const char* status){
  klog_printf("[wc] assets: %s\n", status);
  char h[160]; int n = snprintf(h, sizeof h, "HTTP/1.0 %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status);
  wh_send_all(c, h, (size_t)n);
}
static int wh_hexv(char c){ return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1; }
static void wh_urldecode(const char* in, char* out, size_t cap){
  size_t o = 0;
  for (; *in && *in != '&' && o + 1 < cap; in++) {
    char c = *in;
    if (c == '+') c = ' ';
    else if (c == '%' && wh_hexv(in[1]) >= 0 && wh_hexv(in[2]) >= 0) { c = (char)(wh_hexv(in[1])*16 + wh_hexv(in[2])); in += 2; }
    out[o++] = ((unsigned char)c < 32 || c == 127) ? ' ' : c;
  }
  out[o] = 0;
}
/* GET /__log?w=<widget>&m=<msg> from the hub loader -> one line in wh.log.
 * Append-only, 400-char cap, control chars stripped, <=120 lines/minute. */
static void wh_hexdecode(const char* in, char* out, size_t cap){
  size_t o = 0;
  while (in[0] && in[0] != '&' && in[1] && in[1] != '&' && o + 1 < cap) {
    int hi = wh_hexv(in[0]), lo = wh_hexv(in[1]);
    if (hi < 0 || lo < 0) break;
    char ch = (char)(hi * 16 + lo); in += 2;
    out[o++] = ((unsigned char)ch < 32 || ch == 127) ? ' ' : ch;
  }
  out[o] = 0;
}
static char g_fseen[16][72]; static int g_fns = 0;   /* widgets already notified this hub load */
static void wh_fail_notify(const char* w, const char* m){
  char (*seen)[72] = g_fseen; int ns = g_fns;
  const char* key = w[0] ? w : "*";
  for (int i = 0; i < ns; i++) if (!strcmp(seen[i], key)) return;
  if (ns >= 16) return;
  snprintf(seen[ns], sizeof seen[0], "%s", key); g_fns = ns + 1;
  if (w[0]) notify("Widget failed: %s\n%.160s\nDetails: " WH_WIDGETS_DIR "/wh.log", w, m);
  else notify("Widgets failed to load\n%.160s\nDetails: " WH_WIDGETS_DIR "/wh.log", m);
}
static void wh_log_endpoint(int c, char* q){
  static time_t win = 0; static int cnt = 0, dropped = 0;
  time_t now = time(0);
  if (now - win >= 60) { if (dropped) wh_flog("assets", "log rate limit: dropped %d lines", dropped); win = now; cnt = 0; dropped = 0; }
  if (++cnt > 120) { dropped++; wh_reply(c, "204 No Content"); return; }
  char w[72] = "", m[401] = ""; int fatal = 0;
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "f=1", 3)) fatal = 1;
    if (!strncmp(t, "w=", 2)) wh_hexdecode(t + 2, w, sizeof w);      /* hex (loader) */
    else if (!strncmp(t, "h=", 2)) wh_hexdecode(t + 2, m, sizeof m);  /* hex (loader) */
    else if (!strncmp(t, "m=", 2)) wh_urldecode(t + 2, m, sizeof m);  /* url-encoded (manual) */
    t = strchr(t, '&'); if (t) t++;
  }
  char tag[96] = "hub";
  if (w[0] && wh_name_ok(w, strlen(w))) snprintf(tag, sizeof tag, "widget:%s", w);
  if (m[0]) wh_flog(tag, "%s", m);
  if (!strncmp(m, "loader ready in the hub runtime", 31)) g_fns = 0;   /* new hub load: notify again */
  if (fatal && m[0]) wh_fail_notify(w[0] && wh_name_ok(w, strlen(w)) ? w : "", m);
  wh_reply(c, "204 No Content");
}
#define WH_SET_MAX 2048
#define WH_SET_FILE ".settings.json"
/* GET /__wget?w=<id> -> that widget's saved settings JSON (loopback only). */
static void wh_settings_get(int c, char* q){
  char w[72] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "w=", 2)) { size_t o = 0; for (char* u = t + 2; *u && *u != '&' && o + 1 < sizeof w; u++) w[o++] = *u; w[o] = 0; }
    t = strchr(t, '&'); if (t) t++;
  }
  char body[WH_SET_MAX + 1] = "{}"; long blen = 2;
  if (w[0] && wh_name_ok(w, strlen(w))) {
    char fp[256]; snprintf(fp, sizeof fp, "%s/%s/%s", WH_WIDGETS_DIR, w, WH_SET_FILE);
    int fd = open(fp, O_RDONLY | O_NOFOLLOW);
    if (fd >= 0) {
      struct stat st;
      if (!fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_size > 0 && st.st_size <= WH_SET_MAX) {
        ssize_t r = read(fd, body, (size_t)st.st_size); if (r > 0) { body[r] = 0; blen = r; }
      }
      close(fd);
    }
  }
  char h[200]; int n = snprintf(h, sizeof h,
    "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: %ld\r\nConnection: close\r\n\r\n", blen);
  wh_send_all(c, h, (size_t)n); wh_send_all(c, body, (size_t)blen);
}
/* GET /__wset?w=<id>&h=<hex json> -> write the widget's settings (atomic, <=2 KB, 120/min). */
static void wh_settings_set(int c, char* q){
  static time_t win = 0; static int cnt = 0;
  time_t now = time(0);
  if (now - win >= 60) { win = now; cnt = 0; }
  if (++cnt > 120) { wh_reply(c, "204 No Content"); return; }
  char w[72] = ""; char body[WH_SET_MAX + 1] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "w=", 2)) { size_t o = 0; for (char* u = t + 2; *u && *u != '&' && o + 1 < sizeof w; u++) w[o++] = *u; w[o] = 0; }
    else if (!strncmp(t, "h=", 2)) wh_hexdecode(t + 2, body, sizeof body);
    t = strchr(t, '&'); if (t) t++;
  }
  if (!w[0] || !wh_name_ok(w, strlen(w)) || !body[0] || body[0] != '{') { wh_reply(c, "204 No Content"); return; }
  char fp[256], tp[300];
  snprintf(fp, sizeof fp, "%s/%s/%s", WH_WIDGETS_DIR, w, WH_SET_FILE);
  snprintf(tp, sizeof tp, "%s.tmp", fp);
  int fd = open(tp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd >= 0) {
    size_t bl = strlen(body); int ok = (write(fd, body, bl) == (ssize_t)bl);
    close(fd);
    if (ok && rename(tp, fp) == 0) wh_flog("assets", "saved settings for %s (%zuB)", w, bl);
    else { unlink(tp); wh_flog("assets", "settings save failed for %s", w); }
  }
  wh_reply(c, "204 No Content");
}
static void wh_asset_conn(int c){
  char req[1024]; size_t got = 0;
  while (got < sizeof req - 1){
    ssize_t r = read(c, req + got, sizeof req - 1 - got);
    if (r <= 0) break;
    got += (size_t)r; req[got] = 0;
    if (strstr(req, "\r\n")) break;          /* only the request line matters */
  }
  req[got] = 0;
  char* eol = strstr(req, "\r\n");
  if (!eol) { wh_reply(c, "400 Bad Request"); return; }
  *eol = 0;
  if (strncmp(req, "GET /", 5)) { wh_reply(c, "405 Method Not Allowed"); return; }
  char* path = req + 5;                      /* after "GET /" */
  char* sp = strchr(path, ' '); if (sp) *sp = 0;
  if (!strncmp(path, "__log?", 6)) { wh_log_endpoint(c, path + 6); return; }
  if (!strncmp(path, "__wget?", 7)) { wh_settings_get(c, path + 7); return; }
  if (!strncmp(path, "__wset?", 7)) { wh_settings_set(c, path + 7); return; }
  char shown[100]; snprintf(shown, sizeof shown, "%s", path);   /* for refused-request log lines */
  char* q = strchr(path, '?');  if (q) *q = 0;
  char* sl = strchr(path, '/');
  if (!sl || strchr(sl + 1, '/')) { wh_flog("assets", "refused /%s: path is not /<widget>/<file>", shown); wh_reply(c, "404 Not Found"); return; }
  size_t dl = (size_t)(sl - path), fl = strlen(sl + 1);
  if (!wh_name_ok(path, dl) || !wh_name_ok(sl + 1, fl)) { wh_flog("assets", "refused /%s: invalid characters in name", shown); wh_reply(c, "404 Not Found"); return; }
  const char* type = wh_img_type(sl + 1);
  if (!type) { wh_flog("assets", "refused /%s: not a .png/.jpg image", shown); wh_reply(c, "404 Not Found"); return; }
  *sl = 0;
  char fp[256]; snprintf(fp, sizeof fp, "%s/%s/%s", WH_WIDGETS_DIR, path, sl + 1);
  int fd = open(fp, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) { wh_flog("assets", "refused /%s: file not found", shown); wh_reply(c, "404 Not Found"); return; }
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > WH_ASSET_MAX) {
    close(fd); wh_flog("assets", "refused /%s: not a regular file or over 1 MB", shown); wh_reply(c, "404 Not Found"); return;
  }
  char h[200]; int n = snprintf(h, sizeof h,
    "HTTP/1.0 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\nCache-Control: max-age=60\r\nConnection: close\r\n\r\n",
    type, (long)st.st_size);
  klog_printf("[wc] assets: 200 /%s/%s %ldB\n", path, sl + 1, (long)st.st_size);
  wh_send_all(c, h, (size_t)n);
  char buf[8192]; ssize_t r;
  while ((r = read(fd, buf, sizeof buf)) > 0) wh_send_all(c, buf, (size_t)r);
  close(fd);
}
static unsigned wh_gen_read(void){
  char b[32] = {0}; int fd = open(WH_GEN_FILE, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t r = read(fd, b, sizeof b - 1); close(fd);
  return r > 0 ? (unsigned)strtoul(b, 0, 10) : 0;
}
static unsigned wh_gen_bump(void){
  unsigned g = wh_gen_read() + 1;
  int fd = open(WH_GEN_FILE, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd < 0) return 0;                      /* can't write: never retire on a read */
  char b[32]; int n = snprintf(b, sizeof b, "%u\n", g);
  ssize_t w = write(fd, b, (size_t)n); close(fd);
  return w == n ? g : 0;
}
/* Bind the asset port. Returns the listening socket, or -1 with *why set. */
static int wh_asset_open(unsigned* gen, const char** why){
  *gen = 0; *why = "failed";
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) { klog_printf("[wc] assets: socket failed\n"); return -1; }
  int one = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons(WH_ASSET_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  unsigned my = wh_gen_bump();               /* tells an older server to retire */
  *gen = my;
  int bound = 0;
  for (int t = 0; t < 30 && !bound; t++) {   /* ~6 s for it to notice (it polls 1/s) */
    if (!bind(s, (struct sockaddr*)&a, sizeof a) && !listen(s, 8)) bound = 1;
    else usleep(200000);
  }
  if (!bound) {
    LOG("assets: 127.0.0.1:%d still busy, not serving\n", WH_ASSET_PORT);
    close(s); *why = "port busy"; return -1;
  }
  LOG("assets: serving %s on 127.0.0.1:%d (gen %u)\n", WH_WIDGETS_DIR, WH_ASSET_PORT, my);
  return s;
}
/* Serve until a newer install bumps the generation; never returns. */
static void wh_asset_loop(int s, unsigned my){
  signal(SIGPIPE, SIG_IGN);
  fflush(stdout); fflush(stderr);
  int dn = open("/dev/null", O_RDWR);        /* detach stdio so the loader connection ends */
  if (dn >= 0) { dup2(dn, 0); dup2(dn, 1); dup2(dn, 2); if (dn > 2) close(dn); }
  struct timeval tv = { 2, 0 };
  for (;;) {
    struct pollfd pf = { s, POLLIN, 0 };
    int pr = poll(&pf, 1, 1000);
    if (my && wh_gen_read() > my) {          /* a newer install took over */
      klog_printf("[wc] assets: gen %u superseded, retiring\n", my);
      wh_flog("assets", "server gen %u handed over to a newer install, exiting", my);
      close(s); _exit(0);
    }
    if (pr <= 0) continue;
    int c = accept(s, 0, 0);
    if (c < 0) { if (errno == EINTR) continue; usleep(100000); continue; }
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    wh_asset_conn(c);
    close(c);
  }
}
/* install-time widget summary for the notification */
static int g_wok = 0, g_wbad = 0, g_wmore = 0;
static char g_wfail[200] = "";
static void wh_fail_add(const char* name){
  g_wbad++;
  size_t l = strlen(g_wfail), n = strlen(name);
  if (l + n + 3 >= sizeof g_wfail) { g_wmore++; return; }
  if (l) strcat(g_wfail, ", ");
  strcat(g_wfail, name);
}
static void build_prelude(char** outbuf, size_t* outlen){
  size_t cap = 16384, len = 0;
  char* out = (char*)malloc(cap); out[0] = 0;
  WHAPP(WH_LOADER_HEAD);
  int count = 0;
  DIR* d = opendir(WH_WIDGETS_DIR);
  if (d){
    struct dirent* e;
    while ((e = readdir(d))){
      if (e->d_name[0] == '.') continue;
      char cpath[600], wpath[600];
      snprintf(cpath, sizeof cpath, "%s/%s/config.json", WH_WIDGETS_DIR, e->d_name);
      snprintf(wpath, sizeof wpath, "%s/%s/widget.js", WH_WIDGETS_DIR, e->d_name);
      char* cfg=0; size_t cl=0;
      if (wh_read_file(cpath,&cfg,&cl)) {
        /* Only a folder that looks like a widget (has widget.js) is worth a
         * message; plain files (wh.log) and unrelated folders are ignored. */
        struct stat ws;
        if (!stat(wpath, &ws)) {
          LOG("skip %s: config.json missing or empty\n", e->d_name); wh_fail_add(e->d_name);
        }
        continue;
      }
      char* js=0; size_t jl=0;
      if (wh_read_file(wpath,&js,&jl)) { LOG("skip %s: widget.js missing or empty\n", e->d_name); wh_fail_add(e->d_name); free(cfg); continue; }
      if (!strchr(cfg, '{')) { LOG("skip %s: config.json is not a JSON object\n", e->d_name); wh_fail_add(e->d_name); free(cfg); free(js); continue; }
      char id[128]={0}, title[160]={0}, iconId[64]={0}, desc[400]={0};
      if (wh_json_str(cfg,"id",id,sizeof id)) { strncpy(id, e->d_name, sizeof id-1); LOG("%s: no \"id\" in config.json, using folder name\n", e->d_name); }
      if (wh_json_str(cfg,"title",title,sizeof title)) strncpy(title, id, sizeof title-1);
      /* "glyph": white PNG in the widget folder, served by the asset server and
       * registered as IconPS id "wh:<id>" (the default iconId when one is given) */
      char glyph[80]={0};
      int dir_ok = wh_name_ok(e->d_name, strlen(e->d_name));
      if (!wh_json_str(cfg,"glyph",glyph,sizeof glyph)) {
        if (!dir_ok) { LOG("%s: folder name not servable ([A-Za-z0-9._-]), glyph ignored\n", id); glyph[0]=0; }
        else if (!wh_name_ok(glyph,strlen(glyph)) || !wh_img_type(glyph)) { LOG("%s: glyph \"%s\" ignored (must be a .png/.jpg file name)\n", id, glyph); glyph[0]=0; }
        else { struct stat gs; char gp[600]; snprintf(gp, sizeof gp, "%s/%s/%s", WH_WIDGETS_DIR, e->d_name, glyph);
               if (stat(gp, &gs)) LOG("%s: glyph file %s not found (stock fallback will show)\n", id, glyph); }
      } else glyph[0]=0;
      if (wh_json_str(cfg,"iconId",iconId,sizeof iconId)) {
        if (glyph[0]) snprintf(iconId, sizeof iconId, "wh:%s", id);
        else strncpy(iconId, "app_welcome", sizeof iconId-1);
      }
      wh_json_str(cfg,"description",desc,sizeof desc);   /* optional; stays "" */
      char iconFb[64]={0};                                 /* stock id if wh: glyphs unavailable */
      wh_json_str(cfg,"iconFallback",iconFb,sizeof iconFb);
      double sz = wh_json_num(cfg,"size",1);
      char num[48]; snprintf(num, sizeof num, "',size:%g},'", sz);
      WHAPP("\nif(globalThis.__wh&&!globalThis.__wh.__loaded){globalThis.__wh.__begin({id:'");
      wh_app_esc(&out,&len,&cap, id);
      WHAPP("',title:'");
      wh_app_esc(&out,&len,&cap, title);
      WHAPP("',iconId:'");
      wh_app_esc(&out,&len,&cap, iconId);
      WHAPP("',description:'");
      wh_app_esc(&out,&len,&cap, desc);
      WHAPP("',iconFallback:'");
      wh_app_esc(&out,&len,&cap, iconFb);
      if (dir_ok) {                          /* base URL for this widget's images */
        WHAPP("',assetBase:'" WH_ASSET_URL);
        wh_app_esc(&out,&len,&cap, e->d_name);
        WHAPP("/");
      }
      if (glyph[0]) { WHAPP("',glyph:'"); wh_app_esc(&out,&len,&cap, glyph); }
      WHAPP(num);
      wh_app_esc(&out,&len,&cap, cfg);       /* raw config.json; parsed by the loader */
      WHAPP("');\n");
      WHAPP("try{\n");
      wh_app(&out,&len,&cap, js, jl);
      WHAPP("\n}catch(e){globalThis.__wh.__fail(e);}\nglobalThis.__wh.__end();}\n");
      free(cfg); free(js); count++;
      LOG("widget: id=%s size=%g js=%zuB\n", id, sz, jl);
    }
    closedir(d);
  } else {
    LOG("build_prelude: opendir(%s) failed\n", WH_WIDGETS_DIR);
  }
  /* mark loaded only after every section ran, so all widgets load in the
   * first eval where the handle exists, and never re-run on later evals */
  WHAPP("\nif(globalThis.__wh){globalThis.__wh.__loaded=1;globalThis.__wh.__flush();}\n");
  g_wok = count;
  LOG("build_prelude: widgets=%d failed=%d total=%zuB\n", count, g_wbad, len);
  *outbuf = out; *outlen = len;
}
#undef WHAPP

int main(void){
  size_t blen = (size_t)(bridge_hbc_end - bridge_hbc_start);
  uint64_t bhash = fnv1a64(bridge_hbc_start, blen);
  wh_flog("installer", "---- WHBridge %s start ----", WH_VERSION);
  LOG("start fw=%08x bridge=%zuB magic %02x%02x%02x%02x\n", kernel_get_fw_version(), blen,
      bridge_hbc_start[0],bridge_hbc_start[1],bridge_hbc_start[2],bridge_hbc_start[3]);
  if (blen < 0x100000) { notify("WHBridge failed: embed missing"); return 1; }
  char* prelude = 0; size_t plen = 0;
  build_prelude(&prelude, &plen);
  if (!prelude || !plen) { notify("WHBridge failed: widget code"); return 1; }
  size_t imgcap = CV_PRELUDE + plen + 1;
  size_t cavesz = (imgcap + 0xfff) & ~((size_t)0xfff);
  uint8_t* img = (uint8_t*)calloc(1, imgcap);
  uint8_t* back = (uint8_t*)malloc(imgcap);
  if (!img || !back) { notify("WHBridge failed: out of memory"); return 1; }
  LOG("prelude %zuB cave %zuB\n", plen, cavesz);
  pid_t pid = find_pid("SceShellUI");
  if (pid < 0) { notify("WHBridge failed: ShellUI not found"); return 1; }
  LOG("pid=%d\n", pid);
  if (sys_ptrace(PT_ATTACH, pid, 0, 0)) { notify("WHBridge failed: attach"); return 2; }
  if (waitpid(pid, 0, 0) == -1) { sys_ptrace(PT_DETACH,pid,0,0); notify("WHBridge failed: attach wait"); return 3; }
  LOG("attached\n");
  int rc = 0, reload = 0; uint32_t handle = 0; uintptr_t base = 0, scave = 0, hcave = 0, counter = 0, old_h = 0, fn2 = 0, vslot = 0, dcave = 0;
  int want_dump = (access(WH_DUMP_FLAG, F_OK) == 0);   /* opt-in HBC dump diagnostics */
  if (want_dump) LOG("dump mode ON (%s present): large non-hub bundles will be staged\n", WH_DUMP_FLAG);
  if (kernel_dynlib_handle(pid, "libhermes-0.11.sprx", &handle)) rc = 10;
  else if (!(base = kernel_dynlib_mapbase_addr(pid, handle))) rc = 11;
  else {
    uint64_t slotv=0; uint8_t pro[11]={0};
    int drc = wh_discover(pid, base, &fn2, &vslot);
    if (drc) rc = (drc == 43 || drc == 44) ? 13 : drc;   /* 43/44 = can't find hook point (unsupported FW) */
    else if (remote_read(pid,vslot,&slotv,8)||remote_read(pid,fn2,pro,11)) rc=12;
    else if (memcmp(pro,EXPECTED_PROLOGUE,11)) rc=13;
    if (rc==0 && slotv != fn2) {
      /* Already hooked. Replace it only if the slot points at OUR cave: our detour
       * prologue (first 8 bytes, stable across detour versions) + the "WHBRIDGE"
       * signature at the fixed offset CV_SIG. This recognises our own earlier
       * builds even when the detour's internal layout changed. Anything else: refuse. */
      uint8_t oc[CV_PRELUDE];
      if (remote_read(pid,(uintptr_t)slotv,oc,sizeof oc)) rc=15;
      else if (memcmp(oc+CV_DET, WH_C_DET, 8) || memcmp(oc+CV_SIG, "WHBRIDGE", 8)) rc=15;
      else {
        reload = 1;
        if (get64(oc+CV_SIG+8) == blen && get64(oc+CV_SIG+16) == bhash)
          old_h = get64(oc+CV_BDATA+WH_C_DAIMM);   /* identical bridge already in ShellUI */
        LOG("reload: replacing our hook at %#lx (bridge %s)\n", (long)slotv, old_h ? "reused" : "re-uploaded");
        /* Detour counters from the previous session (see WH_C_CTR_A..D): [0]=slot calls
         * [8]=prelude evaluated [16]=bridge chosen (hub recognised) [24]=bundle returned.
         * swapped=0 with calls>0 means the hub bundle was evaluated WITHOUT the swap. */
        uint64_t pv[4] = {0,0,0,0};
        if (!remote_read(pid,(uintptr_t)slotv+CV_CTR,pv,sizeof pv))
          LOG("prev: calls=%llu prelude=%llu swapped=%llu hub_eval=%llu%s\n",
              (unsigned long long)pv[0],(unsigned long long)pv[1],(unsigned long long)pv[2],(unsigned long long)pv[3],
              (pv[0] && !pv[2]) ? " (hook fired but the hub was NOT swapped: matcher missed)" : "");
        else LOG("prev: counters unreadable\n");
      }
    }
    if (rc==0) {
      uintptr_t g = gadget_of(pid);
      size_t hpg = (blen + 0xfff) & ~((size_t)0xfff);
      if (!g) rc=20;
      else if (!(scave = remote_mmap(pid,g,cavesz,1))) rc=21;
      else if (old_h) hcave = old_h;
      else if (!(hcave = remote_mmap(pid,g,hpg,0))) rc=22;
      else if (remote_write_chunked(pid,hcave,bridge_hbc_start,blen)) rc=23;
      if (rc==0 && want_dump) {
        /* 64 MB staging in ShellUI + a header whctl scans for ("WHDUMPH") */
        dcave = remote_mmap(pid, g, WH_DCAVE_SZ, 0);
        if (!dcave) LOG("dump: staging mmap failed (continuing without dump)\n");
        else {
          uint8_t hdr[0x40]; memset(hdr,0,sizeof hdr);
          memcpy(hdr,"WHDUMPH",8); put64(hdr+8,(uint64_t)WH_DUMP_CAP); put64(hdr+16,0);
          if (remote_write_d(pid,dcave,hdr,sizeof hdr)) { LOG("dump: header write failed\n"); dcave=0; }
          else LOG("dump: staging %zuMB @ %#lx (cap %d)\n", WH_DCAVE_SZ>>20, (long)dcave, WH_DUMP_CAP);
        }
      }
      if (rc==0) {
        uintptr_t S = scave; counter = S + CV_CTR;
        /* img: heap-allocated in main */
        memcpy(img+CV_DET, WH_C_DET, sizeof WH_C_DET);
        put64(img+CV_DET+WH_C_SHARED, S+CV_PSHARED);
        put64(img+CV_DET+WH_C_URL,    S+CV_URL);
        put64(img+CV_DET+WH_C_ORIG_A, fn2);
        put64(img+CV_DET+WH_C_ORIG_B, fn2);
        put64(img+CV_DET+WH_C_BRIDGE, S+CV_BSHARED);
        put64(img+CV_DET+WH_C_MATCHFN, S+CV_MATCH);
        /* choose_buffer helper + the hub signature it scans for (content detection) */
        memcpy(img+CV_MATCH, WH_C_MATCH, sizeof WH_C_MATCH);
        put64(img+CV_MATCH+WH_M_NEEDLE, S+CV_NEEDLE);
        put64(img+CV_MATCH+WH_M_DUMPHDR, dcave);   /* 0 => dump disabled (block skipped) */
        memcpy(img+CV_NEEDLE, WH_NEEDLE, WH_NEEDLE_LEN);
        put64(img+CV_DET+WH_C_CTR_A,  S+CV_CTR);
        put64(img+CV_DET+WH_C_CTR_B,  S+CV_CTR);
        put64(img+CV_DET+WH_C_CTR_C,  S+CV_CTR);
        put64(img+CV_DET+WH_C_CTR_D,  S+CV_CTR);
        memcpy(img+CV_PSIZE, WH_C_SIZE, sizeof WH_C_SIZE); put64(img+CV_PSIZE+WH_C_SZIMM, (uint64_t)plen);
        memcpy(img+CV_PDATA, WH_C_DATA, sizeof WH_C_DATA); put64(img+CV_PDATA+WH_C_DAIMM, S+CV_PRELUDE);
        memcpy(img+CV_DTOR,  WH_C_DTOR, sizeof WH_C_DTOR);
        put64(img+CV_PVT+0, S+CV_DTOR); put64(img+CV_PVT+8, S+CV_DTOR); put64(img+CV_PVT+16, S+CV_PSIZE); put64(img+CV_PVT+24, S+CV_PDATA);
        put64(img+CV_PBUF, S+CV_PVT);
        put64(img+CV_PCTRL+0,0); put64(img+CV_PCTRL+8,0x40000000); put64(img+CV_PCTRL+16,0x40000000);
        put64(img+CV_PSHARED+0, S+CV_PBUF); put64(img+CV_PSHARED+8, S+CV_PCTRL);
        img[CV_URL]=(uint8_t)(2u<<1); img[CV_URL+1]='w'; img[CV_URL+2]='h';
        memcpy(img+CV_BSIZE, WH_C_SIZE, sizeof WH_C_SIZE); put64(img+CV_BSIZE+WH_C_SZIMM, (uint64_t)blen);
        memcpy(img+CV_BDATA, WH_C_DATA, sizeof WH_C_DATA); put64(img+CV_BDATA+WH_C_DAIMM, hcave);
        put64(img+CV_BVT+0, S+CV_DTOR); put64(img+CV_BVT+8, S+CV_DTOR); put64(img+CV_BVT+16, S+CV_BSIZE); put64(img+CV_BVT+24, S+CV_BDATA);
        put64(img+CV_BBUF, S+CV_BVT);
        put64(img+CV_BCTRL+0,0); put64(img+CV_BCTRL+8,0x40000000); put64(img+CV_BCTRL+16,0x40000000);
        put64(img+CV_BSHARED+0, S+CV_BBUF); put64(img+CV_BSHARED+8, S+CV_BCTRL);
        memcpy(img+CV_SIG, "WHBRIDGE", 8); put64(img+CV_SIG+8, (uint64_t)blen);
        put64(img+CV_SIG+16, bhash); put64(img+CV_SIG+24, WH_SIG_VER);
        memcpy(img+CV_PRELUDE, prelude, plen+1);
        size_t imglen = CV_PRELUDE + plen + 1;
        if (remote_write_d(pid, scave, img, imglen)) rc=25;
        else {
          /* back: heap-allocated in main */
          if (remote_read(pid,scave,back,imglen)||memcmp(back,img,imglen)) rc=26;
          else {
            int prot = kernel_get_vmem_protection(pid,vslot,8);
            kernel_set_vmem_protection(pid,vslot,8,prot|PROT_READ|PROT_WRITE);
            uint64_t ns = S+CV_DET;
            if (remote_write_d(pid,vslot,&ns,8)) rc=27;
            else { uint64_t c=0; remote_read(pid,vslot,&c,8); if(c!=ns) rc=28; else LOG("INSTALLED slot2->%#lx bridge %zuB @ %#lx%s\n",(long)ns,blen,(long)hcave,reload ? (old_h ? " (reload, bridge reused)" : " (reload)") : ""); }
            if (prot>=0) kernel_set_vmem_protection(pid,vslot,8,prot);
          }
        }
      }
    }
  }
  LOG("ADDRS base=%#lx scave=%#lx hcave=%#lx counter=%#lx vslot2=%#lx\n",
      (long)base,(long)scave,(long)hcave,(long)counter,(long)vslot);
  if (sys_ptrace(PT_DETACH,pid,0,0)) LOG("detach failed\n"); else LOG("detached\n");
  LOG("done rc=%d\n", rc);
  if (rc) {
    const char* why = rc==10 ? "libhermes not loaded in ShellUI" : rc==11 ? "libhermes base not found"
      : rc==12 ? "could not read ShellUI memory" : rc==13 ? "could not locate evaluateJavaScript (unsupported firmware?)"
      : rc==15 ? "evaluateJavaScript is hooked by something else; left untouched"
      : rc>=40 && rc<=42 ? "could not scan libhermes to find the hook point"
      : rc>=20 && rc<=24 ? "could not allocate/write memory in ShellUI" : rc>=25 && rc<=26 ? "code cave write/verify failed"
      : rc>=27 ? "could not update the hook pointer" : "unknown";
    LOG("install failed (rc=%d): %s\n", rc, why);
  }
  free(img); free(back); free(prelude);
  /* Stay resident as the widget asset server (the hub's Image only loads http://). */
  unsigned gen = 0; const char* why = "";
  int as = wh_asset_open(&gen, &why);
  const char* hook = rc == 0 ? (reload ? "WHBridge reloaded" : "WHBridge loaded")
                  : rc == 15 ? "WHBridge failed: hook owned by something else" : "WHBridge failed";
  int plain = (rc == 0 || rc == 15);         /* message already says it all */
  char wsum[300] = "";
  if (rc == 0) {
    if (g_wbad) snprintf(wsum, sizeof wsum, "\nWidgets: %d loaded, %d failed (%s%s)", g_wok, g_wbad, g_wfail, g_wmore ? ", ..." : "");
    else snprintf(wsum, sizeof wsum, "\nWidgets: %d loaded", g_wok);
  }
  if (as >= 0) {
    if (plain) notify("%s  v%s%s\nAsset server: running", hook, WH_VERSION, wsum);
    else notify("%s (rc=%d)  v%s\nAsset server: running", hook, rc, WH_VERSION);
    wh_asset_loop(as, gen);                  /* does not return */
  }
  if (plain) notify("%s  v%s%s\nAsset server: not running (%s)", hook, WH_VERSION, wsum, why);
  else notify("%s (rc=%d)  v%s\nAsset server: not running (%s)", hook, rc, WH_VERSION, why);
  return rc;
}
