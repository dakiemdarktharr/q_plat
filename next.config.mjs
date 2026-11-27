import {withWorkflow} from 'workflow/next';
export default withWorkflow({
  poweredByHeader:false,
  serverExternalPackages:['mongodb'],
  outputFileTracingIncludes:{'/*':['./index.html']},
  async headers(){return [{source:'/(.*)',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'same-origin'},{key:'X-Frame-Options',value:'DENY'}]}];}
});
