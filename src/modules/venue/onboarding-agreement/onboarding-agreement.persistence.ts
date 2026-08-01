import type { Db, Document } from "mongodb";
const bps = { bsonType: "int", minimum: 0, maximum: 10000 };
const validator: Document = {
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: [
      "_id",
      "venue_id",
      "owner_id",
      "title",
      "terms_text",
      "template_id","template_version","terms_hash",
      "platform_commission_bps",
      "settlement_cycle",
      "settlement_lag_days",
      "cancellation_policy",
      "status",
      "version",
      "proposed_by",
      "proposed_at",
      "accepted_by",
      "accepted_at",
      "acceptance_ip",
      "acceptance_user_agent",
      "audit_history",
      "created_at",
      "updated_at",
    ],
    properties: {
      _id: { bsonType: "objectId" },
      venue_id: { bsonType: "objectId" },
      owner_id: { bsonType: "objectId" },
      title: { bsonType: "string" },
      terms_text: { bsonType: "string" },
      template_id:{bsonType:['objectId','null']},template_version:{bsonType:['int','null'],minimum:1},terms_hash:{bsonType:'string'},
      platform_commission_bps: bps,
      settlement_cycle: { enum: ["T_PLUS_N", "WEEKLY", "MONTHLY"] },
      settlement_lag_days: { bsonType: "int", minimum: 0 },
      status: { enum: ["PROPOSED", "CHANGES_REQUESTED", "ACCEPTED", "SUPERSEDED"] },
      version: { bsonType: "int", minimum: 1 },
      cancellation_policy: {
        bsonType: "object",
        additionalProperties: false,
        required: [
          "cancellation_allowed",
          "default_refund_bps",
          "no_show_refund_bps",
          "owner_cancellation_notice_minutes",
          "refund_rules",
        ],
        properties: {
          cancellation_allowed: { bsonType: "bool" },
          default_refund_bps: bps,
          no_show_refund_bps: bps,
          owner_cancellation_notice_minutes: { bsonType: "int", minimum: 0 },
          refund_rules: {
            bsonType: "array",
            maxItems: 50,
            items: {
              bsonType: "object",
              additionalProperties: false,
              required: ["min_minutes_before_start", "refund_bps"],
              properties: {
                min_minutes_before_start: { bsonType: "int", minimum: 0 },
                refund_bps: bps,
              },
            },
          },
        },
      },
      proposed_by: { bsonType: "objectId" },
      proposed_at: { bsonType: "date" },
      accepted_by: { bsonType: ["objectId", "null"] },
      accepted_at: { bsonType: ["date", "null"] },
      acceptance_ip: { bsonType: ["string", "null"] },
      acceptance_user_agent:{bsonType:['string','null']},
      audit_history: { bsonType: "array", maxItems: 100 },
      created_at: { bsonType: "date" },
      updated_at: { bsonType: "date" },
    },
  },
};
export async function initializeOnboardingAgreementPersistence(db: Db) {
  const name = "venue_onboarding_agreements";
  const exists = await db
    .listCollections({ name }, { nameOnly: true })
    .hasNext();
  if(exists){await db.command({collMod:name,validationLevel:'off'});const crypto=await import('node:crypto');const cursor=db.collection<{_id:import('mongodb').ObjectId;terms_text:string}> (name).find({terms_hash:{$exists:false}});for await(const value of cursor)await db.collection(name).updateOne({_id:value._id},{$set:{template_id:null,template_version:null,terms_hash:crypto.createHash('sha256').update(value.terms_text).digest('hex'),acceptance_user_agent:null}});}
  if (!exists)
    await db.createCollection(name, {
      validator,
      validationLevel: "strict",
      validationAction: "error",
    });
  else
    await db.command({
      collMod: name,
      validator,
      validationLevel: "strict",
      validationAction: "error",
    });
  await db
    .collection(name)
    .createIndex(
      { venue_id: 1, status: 1 },
      { name: "ix_onboarding_agreement_venue_status" },
    );
  await db
    .collection(name)
    .createIndex(
      { venue_id: 1, version: 1 },
      { unique: true, name: "uq_onboarding_agreement_version" },
    );
  const templateName="contract_templates";
  const templateValidator:Document={$jsonSchema:{bsonType:'object',additionalProperties:false,required:['_id','code','title','terms_text','version','status','created_by','created_at','updated_at'],properties:{_id:{bsonType:'objectId'},code:{bsonType:'string'},title:{bsonType:'string'},terms_text:{bsonType:'string'},version:{bsonType:'int',minimum:1},status:{enum:['ACTIVE','SUPERSEDED']},created_by:{bsonType:'objectId'},created_at:{bsonType:'date'},updated_at:{bsonType:'date'}}}};
  if(!await db.listCollections({name:templateName},{nameOnly:true}).hasNext())await db.createCollection(templateName,{validator:templateValidator,validationLevel:'strict',validationAction:'error'});else await db.command({collMod:templateName,validator:templateValidator,validationLevel:'strict',validationAction:'error'});
  await db.collection(templateName).createIndex({code:1,version:1},{unique:true,name:'uq_contract_template_version'});
}
